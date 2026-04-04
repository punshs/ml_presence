"""Constants for the ML Presence integration."""

DOMAIN = "ml_presence"
PLATFORMS = ["sensor", "binary_sensor"]

# Config entry data keys
CONF_MODEL_NAME = "model_name"
CONF_MQTT_TOPIC = "mqtt_topic"
CONF_ADDON_SLUG = "addon_slug"

# Options flow keys
CONF_TRIGGER_ENTITIES = "trigger_entities"
CONF_CONTEXT_ENTITIES = "context_entities"
CONF_POLL_INTERVAL = "poll_interval"

# Defaults
DEFAULT_ADDON_SLUG = "4127ca46_ml2mqtt"
DEFAULT_POLL_INTERVAL = 5
DEFAULT_MQTT_TOPIC_PREFIX = "ml2mqtt"

# Frontend
CARD_JS_URL = "/ml_presence/ml2mqtt-training-card.js"
CARD_JS_FILENAME = "ml2mqtt-training-card.js"
