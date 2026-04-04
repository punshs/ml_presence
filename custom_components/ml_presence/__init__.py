"""The ML Presence integration."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from homeassistant.components import mqtt
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_state_change_event

from .api import Ml2MqttApiClient
from .const import (
    CARD_JS_FILENAME,
    CARD_JS_URL,
    CONF_ADDON_SLUG,
    CONF_CONTEXT_ENTITIES,
    CONF_MODEL_NAME,
    CONF_MQTT_TOPIC,
    CONF_TRIGGER_ENTITIES,
    DEFAULT_ADDON_SLUG,
    DEFAULT_MQTT_TOPIC_PREFIX,
    DOMAIN,
    PLATFORMS,
)
from .coordinator import MlPresenceCoordinator

_LOGGER = logging.getLogger(__name__)




def _build_addon_url(slug: str) -> str:
    """Build the direct container URL for an add-on."""
    hostname = slug.replace("_", "-")
    return f"http://{hostname}:5000"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the ML Presence integration (YAML — not used)."""
    hass.data.setdefault(DOMAIN, {})

    # Register the frontend card JS as a static path (one-time).
    card_path = Path(__file__).parent / CARD_JS_FILENAME
    if card_path.is_file():
        try:
            await hass.http.async_register_static_paths(
                [StaticPathConfig(CARD_JS_URL, str(card_path), cache_headers=False)]
            )
            _LOGGER.info("Registered ML Presence training card at %s", CARD_JS_URL)
        except Exception:
            _LOGGER.debug("Static path already registered or failed", exc_info=True)

        # Auto-register as a Lovelace resource so users don't have to.
        await _async_register_lovelace_resource(hass)

    return True


async def _async_register_lovelace_resource(hass: HomeAssistant) -> None:
    """Register the training card JS as a Lovelace resource if not already present."""
    try:
        # Check existing resources
        resources: list[dict] = await hass.data["lovelace"]["resources"].async_get_info()
        for res in resources:
            if CARD_JS_URL in res.get("url", ""):
                _LOGGER.debug("Lovelace resource already registered: %s", CARD_JS_URL)
                return

        # Not found — register it
        await hass.data["lovelace"]["resources"].async_create_item(
            {"res_type": "module", "url": CARD_JS_URL}
        )
        _LOGGER.info("Auto-registered Lovelace resource: %s", CARD_JS_URL)
    except Exception:
        _LOGGER.debug(
            "Could not auto-register Lovelace resource (may need manual setup)",
            exc_info=True,
        )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up ML Presence from a config entry."""
    model_name: str = entry.data[CONF_MODEL_NAME]
    mqtt_topic: str = entry.data.get(
        CONF_MQTT_TOPIC, f"{DEFAULT_MQTT_TOPIC_PREFIX}/{model_name}"
    )
    addon_slug: str = entry.data.get(CONF_ADDON_SLUG, DEFAULT_ADDON_SLUG)

    _LOGGER.info(
        "Setting up ML Presence for model=%s, topic=%s", model_name, mqtt_topic
    )

    # ------------------------------------------------------------------
    # 1. Create the API client & coordinator
    # ------------------------------------------------------------------
    session = async_get_clientsession(hass)
    base_url = _build_addon_url(addon_slug)
    api = Ml2MqttApiClient(session, base_url)

    coordinator = MlPresenceCoordinator(hass, entry, api)
    await coordinator.async_config_entry_first_refresh()

    # Store in hass.data for platform access
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        "coordinator": coordinator,
        "api": api,
        "unsub_listeners": [],
    }

    # ------------------------------------------------------------------
    # 2. Subscribe to MQTT for instant prediction push
    # ------------------------------------------------------------------
    state_topic = f"{mqtt_topic}/state"

    @callback
    def _handle_mqtt_message(msg: mqtt.ReceiveMessage) -> None:
        """Handle incoming MQTT prediction message."""
        try:
            payload = json.loads(msg.payload)
            prediction = payload.get("state", "unknown")
            confidence = float(payload.get("confidence", 0.0))
            coordinator.handle_mqtt_prediction(prediction, confidence)
        except (json.JSONDecodeError, ValueError, TypeError):
            _LOGGER.warning("Invalid MQTT payload on %s: %s", state_topic, msg.payload)

    unsub_mqtt = await mqtt.async_subscribe(hass, state_topic, _handle_mqtt_message)
    hass.data[DOMAIN][entry.entry_id]["unsub_listeners"].append(unsub_mqtt)
    _LOGGER.info("Subscribed to MQTT topic: %s", state_topic)

    # ------------------------------------------------------------------
    # 3. Set up the sensor bridge (replaces the old automations)
    # ------------------------------------------------------------------
    _setup_sensor_bridge(hass, entry, mqtt_topic)

    # ------------------------------------------------------------------
    # 4. Forward entry setup to platforms
    # ------------------------------------------------------------------
    await hass.config_entries.async_forward_entry_setups(
        entry, PLATFORMS
    )

    # ------------------------------------------------------------------
    # 5. Listen for options updates (sensor list changes)
    # ------------------------------------------------------------------
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))

    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: ConfigEntry
) -> bool:
    """Unload a config entry."""
    # Cancel all listeners
    for unsub in hass.data[DOMAIN][entry.entry_id].get("unsub_listeners", []):
        unsub()

    # Unload platforms
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)

    return unload_ok


async def _async_options_updated(
    hass: HomeAssistant, entry: ConfigEntry
) -> None:
    """Handle options update — rebuild the sensor bridge."""
    _LOGGER.info("Options updated for %s, reloading", entry.data[CONF_MODEL_NAME])
    await hass.config_entries.async_reload(entry.entry_id)


# ======================================================================
# Sensor Bridge — replaces the old HA automations
# ======================================================================

@callback
def _setup_sensor_bridge(
    hass: HomeAssistant,
    entry: ConfigEntry,
    mqtt_topic: str,
) -> None:
    """Register state-change listeners that publish sensor data to MQTT.

    Trigger entities fire a publish on every state change.
    The payload includes the current state of ALL tracked entities
    (both trigger and context).
    """
    trigger_entities: list[str] = entry.options.get(CONF_TRIGGER_ENTITIES, [])
    context_entities: list[str] = entry.options.get(CONF_CONTEXT_ENTITIES, [])
    all_entities = trigger_entities + context_entities
    publish_topic = f"{mqtt_topic}/set"

    if not trigger_entities:
        _LOGGER.warning(
            "No trigger entities configured for %s — sensor bridge inactive. "
            "Go to Settings → Devices & Services → ML Presence → Configure to add sensors.",
            entry.data[CONF_MODEL_NAME],
        )
        return

    _LOGGER.info(
        "Sensor bridge active: %d triggers, %d context entities → %s",
        len(trigger_entities),
        len(context_entities),
        publish_topic,
    )

    @callback
    def _on_trigger_state_change(event: Event) -> None:
        """A trigger entity changed — publish all entity states to MQTT."""
        payload: dict[str, str] = {}
        for entity_id in all_entities:
            state = hass.states.get(entity_id)
            if state is not None:
                payload[entity_id] = state.state
            else:
                payload[entity_id] = "unavailable"

        mqtt.async_publish(hass, publish_topic, json.dumps(payload))

    unsub = async_track_state_change_event(hass, trigger_entities, _on_trigger_state_change)
    hass.data[DOMAIN][entry.entry_id]["unsub_listeners"].append(unsub)
