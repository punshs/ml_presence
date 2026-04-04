"""DataUpdateCoordinator for ML Presence — polls the ml2mqtt add-on API."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import (
    DataUpdateCoordinator,
    UpdateFailed,
)

from .api import Ml2MqttApiClient, Ml2MqttApiError
from .const import CONF_MODEL_NAME, CONF_POLL_INTERVAL, DEFAULT_POLL_INTERVAL, DOMAIN

_LOGGER = logging.getLogger(__name__)


class MlPresenceCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that polls /api/model/<name>/live on the ml2mqtt add-on.

    Also accepts push updates from MQTT via `async_set_updated_data()`.
    """

    config_entry: ConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        config_entry: ConfigEntry,
        api: Ml2MqttApiClient,
    ) -> None:
        """Initialize the coordinator."""
        self.api = api
        self.model_name: str = config_entry.data[CONF_MODEL_NAME]

        poll_interval = config_entry.options.get(
            CONF_POLL_INTERVAL, DEFAULT_POLL_INTERVAL
        )

        super().__init__(
            hass,
            _LOGGER,
            name=f"ml_presence_{self.model_name}",
            config_entry=config_entry,
            update_interval=timedelta(seconds=poll_interval),
            always_update=False,
        )

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch live data from the add-on API."""
        try:
            data = await self.api.get_live_data(self.model_name)
        except Ml2MqttApiError as err:
            raise UpdateFailed(
                f"Error fetching data for {self.model_name}: {err}"
            ) from err

        return data

    def handle_mqtt_prediction(self, prediction: str, confidence: float) -> None:
        """Accept a push update from the MQTT subscription.

        Merges the new prediction into the existing coordinator data and
        dispatches to all listening entities immediately.
        """
        current = dict(self.data) if self.data else {}
        current["prediction"] = prediction
        current["smoothed_prediction"] = prediction
        current["confidence"] = confidence
        self.async_set_updated_data(current)
