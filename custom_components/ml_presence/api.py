"""Async API client for the ml2mqtt Home Assistant add-on."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)


class Ml2MqttApiClient:
    """Thin async wrapper around the ml2mqtt add-on's HTTP API."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        base_url: str,
    ) -> None:
        """Initialize the API client.

        Args:
            session: An aiohttp.ClientSession (usually from hass.helpers.aiohttp_client).
            base_url: The full base URL of the add-on, e.g.
                      "http://4127ca46-ml2mqtt:5000" for direct container access.
        """
        self._session = session
        self._base_url = base_url.rstrip("/")

    # ------------------------------------------------------------------
    # Model endpoints
    # ------------------------------------------------------------------

    async def list_models(self) -> list[dict[str, Any]]:
        """GET /api/models — list all available model names."""
        return await self._get("/api/models")

    async def get_live_data(self, model_name: str) -> dict[str, Any]:
        """GET /api/model/<name>/live — current prediction, sensors, stats."""
        return await self._get(f"/api/model/{model_name}/live")

    async def get_sensors(self, model_name: str) -> list[dict[str, Any]]:
        """GET /api/model/<name>/sensors — registered sensor keys."""
        return await self._get(f"/api/model/{model_name}/sensors")

    async def get_model_stats(self, model_name: str) -> dict[str, Any]:
        """GET /api/model/<name>/stats — confusion matrix, accuracy, etc."""
        return await self._get(f"/api/model/{model_name}/stats")

    async def retrain(self, model_name: str) -> dict[str, Any]:
        """POST /api/model/<name>/retrain — force model retrain."""
        return await self._post(f"/api/model/{model_name}/retrain")

    async def start_collecting(
        self, model_name: str, label: str
    ) -> dict[str, Any]:
        """POST /api/model/<name>/collect/start — begin observation collection."""
        return await self._post(
            f"/api/model/{model_name}/collect/start",
            json={"label": label},
        )

    async def stop_collecting(self, model_name: str) -> dict[str, Any]:
        """POST /api/model/<name>/collect/stop — stop observation collection."""
        return await self._post(f"/api/model/{model_name}/collect/stop")

    async def create_model(
        self,
        model_name: str,
        mqtt_topic: str | None = None,
    ) -> dict[str, Any]:
        """POST /api/create-model — provision a new model in the add-on."""
        payload: dict[str, Any] = {"model_name": model_name}
        if mqtt_topic:
            payload["mqtt_topic"] = mqtt_topic
        return await self._post("/api/create-model", json=payload)

    # ------------------------------------------------------------------
    # Health / connectivity
    # ------------------------------------------------------------------

    async def async_check_connection(self) -> bool:
        """Check if the add-on API is reachable."""
        try:
            await self._get("/api/models")
            return True
        except (Ml2MqttApiError, aiohttp.ClientError, asyncio.TimeoutError):
            return False

    # ------------------------------------------------------------------
    # Internal HTTP helpers
    # ------------------------------------------------------------------

    async def _get(self, path: str) -> Any:
        """Execute a GET request."""
        url = f"{self._base_url}{path}"
        try:
            async with asyncio.timeout(10):
                resp = await self._session.get(url)
                resp.raise_for_status()
                return await resp.json()
        except asyncio.TimeoutError as err:
            raise Ml2MqttApiError(
                f"Timeout connecting to ml2mqtt at {url}"
            ) from err
        except aiohttp.ClientResponseError as err:
            raise Ml2MqttApiError(
                f"HTTP {err.status} from ml2mqtt: {err.message}"
            ) from err
        except aiohttp.ClientError as err:
            raise Ml2MqttApiError(
                f"Error communicating with ml2mqtt at {url}: {err}"
            ) from err

    async def _post(self, path: str, json: dict | None = None) -> Any:
        """Execute a POST request."""
        url = f"{self._base_url}{path}"
        try:
            async with asyncio.timeout(30):
                resp = await self._session.post(url, json=json)
                resp.raise_for_status()
                return await resp.json()
        except asyncio.TimeoutError as err:
            raise Ml2MqttApiError(
                f"Timeout connecting to ml2mqtt at {url}"
            ) from err
        except aiohttp.ClientResponseError as err:
            raise Ml2MqttApiError(
                f"HTTP {err.status} from ml2mqtt: {err.message}"
            ) from err
        except aiohttp.ClientError as err:
            raise Ml2MqttApiError(
                f"Error communicating with ml2mqtt at {url}: {err}"
            ) from err


class Ml2MqttApiError(Exception):
    """Exception for ml2mqtt API communication errors."""
