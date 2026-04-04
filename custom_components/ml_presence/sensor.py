"""Sensor platform for ML Presence — predicted room, confidence, observations."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.sensor import (
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
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
    """Set up ML Presence sensor entities."""
    coordinator: MlPresenceCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    model_name: str = entry.data[CONF_MODEL_NAME]

    entities = [
        MlPresencePredictionSensor(coordinator, entry, model_name),
        MlPresenceConfidenceSensor(coordinator, entry, model_name),
        MlPresenceObservationsSensor(coordinator, entry, model_name),
    ]
    async_add_entities(entities)


class MlPresenceBaseSensor(CoordinatorEntity[MlPresenceCoordinator], SensorEntity):
    """Base class for ML Presence sensors."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: MlPresenceCoordinator,
        entry: ConfigEntry,
        model_name: str,
        key: str,
    ) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self._model_name = model_name
        self._attr_unique_id = f"ml_presence_{model_name}_{key}"
        # Associate with a virtual device for the model
        self._attr_device_info = {
            "identifiers": {(DOMAIN, f"ml_presence_{model_name}")},
            "name": f"ML Presence — {model_name}",
            "manufacturer": "ml2mqtt",
            "model": "Presence Model",
            "sw_version": "1.0.0",
        }

    @property
    def _data(self) -> dict[str, Any]:
        """Shortcut to coordinator data."""
        return self.coordinator.data or {}


class MlPresencePredictionSensor(MlPresenceBaseSensor):
    """Sensor showing the current room prediction."""

    _attr_icon = "mdi:map-marker-radius"
    _attr_translation_key = "predicted_room"

    def __init__(
        self,
        coordinator: MlPresenceCoordinator,
        entry: ConfigEntry,
        model_name: str,
    ) -> None:
        """Initialize the prediction sensor."""
        super().__init__(coordinator, entry, model_name, "predicted_room")
        self._attr_name = "Predicted Room"

    @property
    def native_value(self) -> str | None:
        """Return the smoothed prediction."""
        return self._data.get("smoothed_prediction") or self._data.get("prediction")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return extra attributes."""
        attrs: dict[str, Any] = {}
        if "confidence" in self._data:
            attrs["confidence"] = self._data["confidence"]
        if "prediction" in self._data:
            attrs["raw_prediction"] = self._data["prediction"]
        if "learning_type" in self._data:
            attrs["learning_type"] = self._data["learning_type"]
        if "labels" in self._data:
            attrs["known_rooms"] = self._data["labels"]
        return attrs


class MlPresenceConfidenceSensor(MlPresenceBaseSensor):
    """Sensor showing prediction confidence as a percentage."""

    _attr_icon = "mdi:percent-circle"
    _attr_native_unit_of_measurement = "%"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 1
    _attr_translation_key = "confidence"

    def __init__(
        self,
        coordinator: MlPresenceCoordinator,
        entry: ConfigEntry,
        model_name: str,
    ) -> None:
        """Initialize the confidence sensor."""
        super().__init__(coordinator, entry, model_name, "confidence")
        self._attr_name = "Confidence"

    @property
    def native_value(self) -> float | None:
        """Return the confidence as a percentage 0-100."""
        conf = self._data.get("confidence")
        if conf is not None:
            return round(float(conf) * 100, 1)
        return None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return the predicted room alongside confidence."""
        attrs: dict[str, Any] = {}
        prediction = self._data.get("smoothed_prediction") or self._data.get(
            "prediction"
        )
        if prediction:
            attrs["predicted_room"] = prediction
        return attrs


class MlPresenceObservationsSensor(MlPresenceBaseSensor):
    """Sensor showing the total number of training observations."""

    _attr_icon = "mdi:database"
    _attr_state_class = SensorStateClass.TOTAL
    _attr_translation_key = "observations"

    def __init__(
        self,
        coordinator: MlPresenceCoordinator,
        entry: ConfigEntry,
        model_name: str,
    ) -> None:
        """Initialize the observations sensor."""
        super().__init__(coordinator, entry, model_name, "observations")
        self._attr_name = "Training Observations"

    @property
    def native_value(self) -> int | None:
        """Return the total observation count."""
        return self._data.get("observation_count")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return accuracy and per-label stats."""
        attrs: dict[str, Any] = {}
        if "accuracy" in self._data and self._data["accuracy"] is not None:
            attrs["model_accuracy"] = round(float(self._data["accuracy"]) * 100, 1)
        if "label_stats" in self._data:
            attrs["label_distribution"] = self._data["label_stats"]
        return attrs
