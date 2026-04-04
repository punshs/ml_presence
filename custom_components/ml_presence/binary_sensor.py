"""Binary sensor platform for ML Presence — collecting state."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_MODEL_NAME, DOMAIN
from .coordinator import MlPresenceCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up ML Presence binary sensor entities."""
    coordinator: MlPresenceCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    model_name: str = entry.data[CONF_MODEL_NAME]

    async_add_entities([MlPresenceCollectingSensor(coordinator, entry, model_name)])


class MlPresenceCollectingSensor(
    CoordinatorEntity[MlPresenceCoordinator], BinarySensorEntity
):
    """Binary sensor indicating whether training data collection is active."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:record-circle"
    _attr_translation_key = "collecting"

    def __init__(
        self,
        coordinator: MlPresenceCoordinator,
        entry: ConfigEntry,
        model_name: str,
    ) -> None:
        """Initialize the collecting sensor."""
        super().__init__(coordinator)
        self._model_name = model_name
        self._attr_unique_id = f"ml_presence_{model_name}_collecting"
        self._attr_name = "Collecting"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, f"ml_presence_{model_name}")},
            "name": f"ML Presence — {model_name}",
            "manufacturer": "ml2mqtt",
            "model": "Presence Model",
            "sw_version": "1.0.0",
        }

    @property
    def is_on(self) -> bool | None:
        """Return True if the model is in collection mode."""
        data = self.coordinator.data or {}
        return data.get("collecting", False)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return the collecting label if active."""
        data = self.coordinator.data or {}
        attrs: dict[str, Any] = {}
        label = data.get("collecting_label")
        if label:
            attrs["collecting_label"] = label
        return attrs
