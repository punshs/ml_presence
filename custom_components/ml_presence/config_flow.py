"""Config flow for ML Presence integration."""
from __future__ import annotations

import logging
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import Ml2MqttApiClient
from .const import (
    CONF_ADDON_SLUG,
    CONF_CONTEXT_ENTITIES,
    CONF_MODEL_NAME,
    CONF_MQTT_TOPIC,
    CONF_POLL_INTERVAL,
    CONF_TRIGGER_ENTITIES,
    DEFAULT_ADDON_SLUG,
    DEFAULT_MQTT_TOPIC_PREFIX,
    DEFAULT_POLL_INTERVAL,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


def _build_addon_url(slug: str) -> str:
    """Build the direct container URL for an add-on."""
    # Inside the HA Docker network, add-ons are reachable at
    # http://<slug_with_underscores_replaced>:PORT
    hostname = slug.replace("_", "-")
    return f"http://{hostname}:5000"


class MlPresenceConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for ML Presence."""

    VERSION = 1

    async def async_step_user(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Step 1: Basic model configuration."""
        errors: dict[str, str] = {}

        if user_input is not None:
            model_name = user_input[CONF_MODEL_NAME].strip().lower()
            addon_slug = user_input.get(CONF_ADDON_SLUG, DEFAULT_ADDON_SLUG)
            mqtt_topic = user_input.get(
                CONF_MQTT_TOPIC,
                f"{DEFAULT_MQTT_TOPIC_PREFIX}/{model_name}",
            )

            # Prevent duplicate config entries for the same model
            await self.async_set_unique_id(f"ml_presence_{model_name}")
            self._abort_if_unique_id_configured()

            # Validate connectivity to the add-on
            session = async_get_clientsession(self.hass)
            base_url = _build_addon_url(addon_slug)
            api = Ml2MqttApiClient(session, base_url)

            if await api.async_check_connection():
                # Check if the model exists
                try:
                    models = await api.list_models()
                    model_list = models if isinstance(models, list) else models.get("models", [])
                    model_names = [
                        m.lower() if isinstance(m, str) else m.get("name", "").lower()
                        for m in model_list
                    ]

                    if model_name not in model_names:
                        # Offer to create the model
                        try:
                            await api.create_model(model_name, mqtt_topic)
                            _LOGGER.info("Created new model: %s", model_name)
                        except Exception:
                            errors["base"] = "model_not_found"
                except Exception:
                    _LOGGER.exception("Error listing models")
                    errors["base"] = "cannot_connect"

                if not errors:
                    return self.async_create_entry(
                        title=model_name,
                        data={
                            CONF_MODEL_NAME: model_name,
                            CONF_MQTT_TOPIC: mqtt_topic,
                            CONF_ADDON_SLUG: addon_slug,
                        },
                    )
            else:
                errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_MODEL_NAME): str,
                    vol.Optional(
                        CONF_MQTT_TOPIC,
                        default=f"{DEFAULT_MQTT_TOPIC_PREFIX}/",
                    ): str,
                    vol.Optional(
                        CONF_ADDON_SLUG,
                        default=DEFAULT_ADDON_SLUG,
                    ): str,
                }
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> MlPresenceOptionsFlow:
        """Get the options flow handler."""
        return MlPresenceOptionsFlow(config_entry)


class MlPresenceOptionsFlow(config_entries.OptionsFlow):
    """Handle options for a ML Presence config entry.

    This is where the user selects which HA entities to track and push
    to the ml2mqtt model via MQTT.
    """

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """Initialize the options flow."""
        self._config_entry = config_entry

    async def async_step_init(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Main options step — sensor selection and poll interval."""
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        # Pre-fill with current options
        current_triggers = self._config_entry.options.get(
            CONF_TRIGGER_ENTITIES, []
        )
        current_context = self._config_entry.options.get(
            CONF_CONTEXT_ENTITIES, []
        )
        current_poll = self._config_entry.options.get(
            CONF_POLL_INTERVAL, DEFAULT_POLL_INTERVAL
        )

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        CONF_TRIGGER_ENTITIES,
                        default=current_triggers,
                    ): selector.EntitySelector(
                        selector.EntitySelectorConfig(
                            multiple=True,
                        )
                    ),
                    vol.Optional(
                        CONF_CONTEXT_ENTITIES,
                        default=current_context,
                    ): selector.EntitySelector(
                        selector.EntitySelectorConfig(
                            multiple=True,
                        )
                    ),
                    vol.Optional(
                        CONF_POLL_INTERVAL,
                        default=current_poll,
                    ): vol.All(
                        selector.NumberSelector(
                            selector.NumberSelectorConfig(
                                min=1,
                                max=60,
                                step=1,
                                unit_of_measurement="seconds",
                                mode=selector.NumberSelectorMode.SLIDER,
                            )
                        ),
                        vol.Coerce(int),
                    ),
                }
            ),
            description_placeholders={
                "model_name": self._config_entry.data.get(
                    CONF_MODEL_NAME, "unknown"
                )
            },
        )
