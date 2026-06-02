#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from aiohttp import web
from pyhon import Hon

LOGGER = logging.getLogger("hon_bridge")

MIN_POLL_INTERVAL_SECONDS = 60
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


@dataclass
class ZoneState:
    currentTemperature: float | None
    targetTemperature: float | None
    humidity: float | None
    minTemperature: float | None = None
    maxTemperature: float | None = None
    temperatureStep: float | None = None


@dataclass
class WineCoolerState:
    id: str
    name: str
    manufacturer: str
    model: str
    serialNumber: str
    macAddress: str
    online: bool
    lightOn: bool | None
    sabbathMode: bool | None
    programName: str | None
    zone1: ZoneState
    zone2: ZoneState
    lastUpdated: float
    source: str


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
    tmp.replace(path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def as_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return None


def get_appliance_value(appliance: Any, key: str, default: Any = None) -> Any:
    try:
        return appliance.get(key, default)
    except Exception:
        return default


def get_nested(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    value: Any = data
    for key in keys:
        if not isinstance(value, dict):
            return default
        value = value.get(key)
    return default if value is None else value


def get_parameter_bounds(appliance: Any, parameter: str) -> tuple[float | None, float | None, float | None]:
    candidates = [
        f"settings.{parameter}",
        parameter,
    ]

    for key in candidates:
        try:
            setting = appliance.settings.get(key)
        except Exception:
            setting = None

        if setting is not None:
            return (
                as_float(getattr(setting, "min", None)),
                as_float(getattr(setting, "max", None)),
                as_float(getattr(setting, "step", None)),
            )

    return None, None, None


class HonWineCoolerBridge:
    def __init__(self, email: str, password: str, data_dir: Path, poll_interval_seconds: int) -> None:
        self.email = email
        self.password = password
        self.data_dir = data_dir
        self.poll_interval_seconds = max(MIN_POLL_INTERVAL_SECONDS, poll_interval_seconds)

        self.auth_cache_file = data_dir / "auth-cache.json"
        self.state_cache_file = data_dir / "state-cache.json"

        self.hon_context: Any | None = None
        self.hon: Any | None = None
        self.appliance: Any | None = None
        self.state: WineCoolerState | None = None

        self.last_poll_monotonic = 0.0
        self.lock = asyncio.Lock()

    async def start(self) -> None:
        auth_cache = load_json(self.auth_cache_file)
        mobile_id = auth_cache.get("mobileId") or str(uuid.uuid4()).upper()
        refresh_token = auth_cache.get("refreshToken") or ""

        LOGGER.info("Creating pyhOn session")

        try:
            self.hon_context = Hon(
                self.email,
                self.password,
                mobile_id=mobile_id,
                refresh_token=refresh_token,
            )
        except TypeError:
            # Older pyhOn versions may not support mobile_id/refresh_token.
            self.hon_context = Hon(self.email, self.password)

        self.hon = await self.hon_context.__aenter__()

        self._save_auth_cache(mobile_id)

        wine_coolers = [
            appliance
            for appliance in self.hon.appliances
            if getattr(appliance, "appliance_type", None) == "WC"
        ]

        if not wine_coolers:
            raise RuntimeError("No hOn WC / wine cooler appliance found")

        self.appliance = self._choose_base_appliance(wine_coolers)

        try:
            self.hon.subscribe_updates(self._on_hon_update)
            LOGGER.info("Subscribed to pyhOn push updates")
        except Exception as exc:
            LOGGER.warning("pyhOn push update subscription failed; polling will still work: %s", exc)

        self.state = self._normalise_state("initial")
        self.last_poll_monotonic = time.monotonic()
        self._save_state_cache()

        LOGGER.info("Bridge ready for %s", self.state.name)

    async def close(self) -> None:
        if self.hon_context is not None:
            await self.hon_context.__aexit__(None, None, None)

    def _choose_base_appliance(self, appliances: list[Any]) -> Any:
        for appliance in appliances:
            name = getattr(appliance, "nick_name", "") or ""
            if not name.endswith((" Z1", " Z2")):
                return appliance
        return appliances[0]

    def _save_auth_cache(self, mobile_id: str) -> None:
        refresh_token = ""

        try:
            refresh_token = self.hon.api.auth.refresh_token
        except Exception:
            pass

        save_json(
            self.auth_cache_file,
            {
                "mobileId": mobile_id,
                "refreshToken": refresh_token,
                "updatedAt": time.time(),
            },
        )

    def _on_hon_update(self, *_args: Any, **_kwargs: Any) -> None:
        try:
            self.state = self._normalise_state("push")
            self._save_state_cache()
        except Exception:
            LOGGER.exception("Failed to process pyhOn update")

    def _save_state_cache(self) -> None:
        if self.state is None:
            return
        save_json(self.state_cache_file, asdict(self.state))

    async def refresh_if_due(self, force: bool = False) -> WineCoolerState:
        async with self.lock:
            now = time.monotonic()
            elapsed = now - self.last_poll_monotonic

            if not force and self.state is not None and elapsed < self.poll_interval_seconds:
                return self.state

            if self.appliance is None:
                raise RuntimeError("Bridge not initialised")

            if elapsed < self.poll_interval_seconds and self.state is not None:
                return self.state

            LOGGER.info("Polling hOn cloud for status update")
            await self.appliance.update(force=True)

            self.last_poll_monotonic = time.monotonic()
            self.state = self._normalise_state("poll")
            self._save_state_cache()

            return self.state

    def _normalise_state(self, source: str) -> WineCoolerState:
        if self.appliance is None:
            raise RuntimeError("No appliance selected")

        appliance = self.appliance

        data = getattr(appliance, "data", {}) or {}
        appliance_data = data.get("appliance", {}) if isinstance(data, dict) else {}

        mac_address = (
            getattr(appliance, "mac_address", None)
            or appliance_data.get("macAddress")
            or "unknown"
        )

        name = (
            getattr(appliance, "nick_name", None)
            or appliance_data.get("modelName")
            or "Wine Cooler"
        )

        model = (
            getattr(appliance, "model_name", None)
            or appliance_data.get("modelName")
            or "Wine Cooler"
        )

        brand = str(appliance_data.get("brand") or "Haier")
        serial = str(appliance_data.get("serialNumber") or mac_address)

        z1_min, z1_max, z1_step = get_parameter_bounds(appliance, "tempSel")
        z2_min, z2_max, z2_step = get_parameter_bounds(appliance, "tempSelZ2")

        return WineCoolerState(
            id=f"wc_{mac_address}",
            name=str(name),
            manufacturer=brand.title(),
            model=str(model),
            serialNumber=serial,
            macAddress=str(mac_address),
            online=as_bool(appliance_data.get("applianceStatus")) is not False,
            lightOn=as_bool(get_appliance_value(appliance, "lightStatus")),
            sabbathMode=as_bool(get_appliance_value(appliance, "sabbathStatus")),
            programName=get_appliance_value(appliance, "programName"),
            zone1=ZoneState(
                currentTemperature=as_float(get_appliance_value(appliance, "temp")),
                targetTemperature=as_float(get_appliance_value(appliance, "tempSel")),
                humidity=as_float(get_appliance_value(appliance, "humidityZ1")),
                minTemperature=z1_min,
                maxTemperature=z1_max,
                temperatureStep=z1_step,
            ),
            zone2=ZoneState(
                currentTemperature=as_float(get_appliance_value(appliance, "tempZ2")),
                targetTemperature=as_float(get_appliance_value(appliance, "tempSelZ2")),
                humidity=as_float(get_appliance_value(appliance, "humidityZ2")),
                minTemperature=z2_min,
                maxTemperature=z2_max,
                temperatureStep=z2_step,
            ),
            lastUpdated=time.time(),
            source=source,
        )

    async def send_setting(self, parameter: str, value: Any) -> WineCoolerState:
        async with self.lock:
            if self.appliance is None:
                raise RuntimeError("Bridge not initialised")

            command = self.appliance.commands["settings"]

            setting = None

            try:
                setting = command.settings.get(parameter)
            except Exception:
                setting = None

            if setting is None:
                try:
                    setting = self.appliance.settings.get(f"settings.{parameter}")
                except Exception:
                    setting = None

            if setting is None:
                raise RuntimeError(f"Setting {parameter!r} is not available")

            setting.value = value

            LOGGER.info("Sending hOn setting %s=%s", parameter, value)

            if hasattr(command, "send_specific"):
                result = await command.send_specific([parameter])
            else:
                result = await command.send()

            if result is False:
                raise RuntimeError(f"hOn rejected setting {parameter}")

            self.state = self._normalise_state(f"write:{parameter}")

            if parameter == "lightStatus":
                self.state.lightOn = as_bool(value)
            elif parameter == "sabbathStatus":
                self.state.sabbathMode = as_bool(value)
            elif parameter == "tempSel":
                self.state.zone1.targetTemperature = as_float(value)
            elif parameter == "tempSelZ2":
                self.state.zone2.targetTemperature = as_float(value)

            self._save_state_cache()
            return self.state


def json_response(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


def state_to_dict(state: WineCoolerState) -> dict[str, Any]:
    return asdict(state)


async def create_app(bridge: HonWineCoolerBridge) -> web.Application:
    app = web.Application()

    async def health(_request: web.Request) -> web.Response:
        return json_response({"ok": bridge.state is not None})

    async def appliances(_request: web.Request) -> web.Response:
        state = await bridge.refresh_if_due(force=False)
        return json_response({"appliances": [state_to_dict(state)]})

    async def state(request: web.Request) -> web.Response:
        force = request.query.get("force") == "true"
        current_state = await bridge.refresh_if_due(force=force)
        return json_response(state_to_dict(current_state))

    async def light(request: web.Request) -> web.Response:
        body = await request.json()
        on = bool(body.get("on"))
        new_state = await bridge.send_setting("lightStatus", "1" if on else "0")
        return json_response(state_to_dict(new_state))

    async def sabbath(request: web.Request) -> web.Response:
        body = await request.json()
        on = bool(body.get("on"))
        new_state = await bridge.send_setting("sabbathStatus", "1" if on else "0")
        return json_response(state_to_dict(new_state))

    async def target_temperature(request: web.Request) -> web.Response:
        zone = int(request.match_info["zone"])
        if zone not in {1, 2}:
            return json_response({"error": "zone must be 1 or 2"}, status=400)

        body = await request.json()
        temperature = int(round(float(body["temperature"])))

        parameter = "tempSel" if zone == 1 else "tempSelZ2"
        new_state = await bridge.send_setting(parameter, str(temperature))
        return json_response(state_to_dict(new_state))

    app.router.add_get("/health", health)
    app.router.add_get("/appliances", appliances)
    app.router.add_get("/state", state)
    app.router.add_post("/light", light)
    app.router.add_post("/sabbath", sabbath)
    app.router.add_post("/zone/{zone}/target-temperature", target_temperature)

    async def cleanup(_app: web.Application) -> None:
        await bridge.close()

    app.on_cleanup.append(cleanup)
    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--poll-interval", type=int, default=MIN_POLL_INTERVAL_SECONDS)
    parser.add_argument("--data-dir", default=os.environ.get("HON_DATA_DIR", "./.hon-data"))
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    email = os.environ.get("HON_USER")
    password = os.environ.get("HON_PASSWORD")

    if not email or not password:
        raise SystemExit("HON_USER and HON_PASSWORD environment variables are required")

    bridge = HonWineCoolerBridge(
        email=email,
        password=password,
        data_dir=Path(args.data_dir),
        poll_interval_seconds=args.poll_interval,
    )

    async def app_factory() -> web.Application:
        await bridge.start()
        return await create_app(bridge)

    web.run_app(app_factory(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()