#include "mqtt_hsm.h"
#include "mqtt_config.h"
#include "hsm.h"
#include "m_mqtt.h"
#include "m_sensor.h"
#include "ph_calibration.h"
#include "cJSON.h"
#include "nvs.h"
#include "esp_crt_bundle.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static hsm_t s_hsm;
static QueueHandle_t s_commands;
static esp_timer_handle_t s_timer;
static bool s_started, s_sntp;
static uint32_t s_cycle = APP_DEFAULT_CYCLE_SECONDS, s_sequence;
static char s_boot_id[17];
static int64_t s_last_publish;
typedef struct { char payload[M_MQTT_PAYLOAD_MAX]; } command_message_t;
typedef struct { char id[65]; char ack[384]; } cached_command_t;
static cached_command_t s_cache[8];
static unsigned s_cache_next;

static bool mqtt_root(hsm_t *hsm, const event_t *event);
static bool offline_handler(hsm_t *hsm, const event_t *event);
static bool connecting_handler(hsm_t *hsm, const event_t *event);
static bool online_handler(hsm_t *hsm, const event_t *event);
static void online_entry(hsm_t *hsm);
static const hsm_state_t root = {.handler=mqtt_root};
static const hsm_state_t offline = {.parent=&root, .handler=offline_handler};
static const hsm_state_t connecting = {.parent=&root, .handler=connecting_handler};
static const hsm_state_t online = {.parent=&root, .handler=online_handler, .entry=online_entry};

static bool save_cycle(uint32_t cycle)
{
    nvs_handle_t handle;
    if (nvs_open("device", NVS_READWRITE, &handle) != ESP_OK) return false;
    esp_err_t err = nvs_set_u32(handle, "mqtt_cycle", cycle);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err == ESP_OK;
}

static bool publish_sample(const char *command_id)
{
    sensor_sample_t sample = {0};
    esp_err_t error = m_sensor_read(&sample);
    cJSON *message = cJSON_CreateObject();
    if (!message) return false;
    char message_id[40];
    snprintf(message_id, sizeof(message_id), "%s:%lu", s_boot_id, (unsigned long)++s_sequence);
    cJSON_AddStringToObject(message, "type", "telemetry");
    cJSON_AddStringToObject(message, "device_id", DEVICE_ID);
    cJSON_AddStringToObject(message, "message_id", message_id);
    cJSON_AddNumberToObject(message, "timestamp", time(NULL));
    cJSON_AddNumberToObject(message, "uptime_seconds", esp_timer_get_time()/1000000);
    cJSON_AddNumberToObject(message, "cycle_seconds", s_cycle);
    cJSON_AddStringToObject(message, "status", "online");
    cJSON_AddBoolToObject(message, "calibrated", APP_PH_CALIBRATED);
    cJSON_AddStringToObject(message, "ph_source", APP_PH_CALIBRATED ? "calibrated" : "default");
    if (command_id && command_id[0]) cJSON_AddStringToObject(message, "command_id", command_id);
    if (error == ESP_OK) {
        cJSON_AddNumberToObject(message, "ph", app_ph_from_voltage(sample.po_voltage));
        cJSON_AddNumberToObject(message, "voltage", sample.po_voltage);
        cJSON_AddNumberToObject(message, "raw_adc", sample.raw);
        cJSON_AddNumberToObject(message, "adc_mv", sample.adc_mv);
        cJSON_AddNullToObject(message, "sensor_error");
    } else {
        cJSON_AddNullToObject(message, "ph");
        cJSON_AddNullToObject(message, "voltage");
        cJSON_AddStringToObject(message, "sensor_error", esp_err_to_name(error));
    }
    char *payload = cJSON_PrintUnformatted(message);
    int result = payload ? m_mqtt_publish(APP_MQTT_UP, payload, 1, false) : -1;
    ESP_LOGI("app_mqtt", "telemetry seq=%lu cycle=%lu voltage=%.3f ph=%.2f calibrated=%d sensor=%s enqueue=%d",
             (unsigned long)s_sequence, (unsigned long)s_cycle, sample.po_voltage,
             error == ESP_OK ? app_ph_from_voltage(sample.po_voltage) : NAN,
             APP_PH_CALIBRATED, esp_err_to_name(error), result);
    cJSON_free(payload); cJSON_Delete(message);
    s_last_publish = esp_timer_get_time();
    return result >= 0;
}

/* Business handlers. Adding a command only needs a handler + one table row. */
static const char *handle_get_status(const cJSON *command, const char *id)
{
    (void)command;
    return publish_sample(id) ? NULL : "publish_failed";
}
static const char *handle_set_cycle(const cJSON *command, const char *id)
{
    (void)id;
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(command, "cycle_seconds");
    if (!cJSON_IsNumber(value) || value->valuedouble < 1 || value->valuedouble > 86400
        || floor(value->valuedouble) != value->valuedouble) return "invalid_cycle_seconds";
    uint32_t cycle = (uint32_t)value->valuedouble;
    if (cycle != s_cycle && !save_cycle(cycle)) return "nvs_write_failed";
    s_cycle = cycle;
    s_last_publish = esp_timer_get_time();
    return NULL;
}
typedef const char *(*command_handler_t)(const cJSON *, const char *);
typedef struct { const char *cmd; command_handler_t handler; } command_entry_t;
static const command_entry_t command_table[] = {
    {"get_status", handle_get_status},
    {"set_cycle", handle_set_cycle},
};

static void dispatch_command(const char *payload)
{
    cJSON *command = cJSON_Parse(payload);
    const cJSON *cmd = cJSON_GetObjectItemCaseSensitive(command, "cmd");
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(command, "command_id");
    const char *name = cJSON_IsString(cmd) ? cmd->valuestring : "";
    const char *command_id = cJSON_IsString(id) ? id->valuestring : "";
    if (strlen(command_id) > 64 || strlen(name) > 32) { cJSON_Delete(command); return; }
    if (command_id[0]) {
        for (unsigned i=0; i<8; ++i) {
            if (!strcmp(s_cache[i].id, command_id)) {
                m_mqtt_publish(APP_MQTT_UP, s_cache[i].ack, 1, false);
                cJSON_Delete(command); return;
            }
        }
    }
    const char *error = cJSON_IsObject(command) && name[0] ? "unknown_cmd" : "invalid_command";
    const cJSON *expiry = cJSON_GetObjectItemCaseSensitive(command, "expires_at");
    bool expired = expiry && (!cJSON_IsNumber(expiry) || expiry->valuedouble < time(NULL));
    if (expired) error = "command_expired";
    for (unsigned i=0; !expired && i<sizeof(command_table)/sizeof(command_table[0]); ++i) {
        if (!strcmp(command_table[i].cmd, name)) {
            error = command_table[i].handler(command, command_id);
            break;
        }
    }
    cJSON *ack = cJSON_CreateObject();
    if (!ack) { cJSON_Delete(command); return; }
    cJSON_AddStringToObject(ack, "type", "ack");
    cJSON_AddStringToObject(ack, "device_id", DEVICE_ID);
    cJSON_AddStringToObject(ack, "command_id", command_id);
    cJSON_AddStringToObject(ack, "cmd", name);
    cJSON_AddBoolToObject(ack, "ok", error == NULL);
    cJSON_AddNumberToObject(ack, "cycle_seconds", s_cycle);
    if (error) cJSON_AddStringToObject(ack, "error", error);
    char *response = cJSON_PrintUnformatted(ack);
    if (response) {
        m_mqtt_publish(APP_MQTT_UP, response, 1, false);
        if (command_id[0]) {
            cached_command_t *cached = &s_cache[s_cache_next++ % 8];
            snprintf(cached->id, sizeof(cached->id), "%s", command_id);
            snprintf(cached->ack, sizeof(cached->ack), "%s", response);
        }
    }
    ESP_LOGI("app_mqtt", "cmd=%s id=%s result=%s cycle=%lu", name, command_id,
             error ? error : "ok", (unsigned long)s_cycle);
    cJSON_free(response); cJSON_Delete(ack); cJSON_Delete(command);
}

static void transport_callback(m_mqtt_event_t type, const char *topic,
                               const char *payload, size_t length, bool retained, void *context)
{
    (void)context;
    event_t event = {.id = type == M_MQTT_CONNECTED ? EVT_MQTT_CONNECTED : EVT_MQTT_DISCONNECTED};
    if (type == M_MQTT_MESSAGE) {
        if (retained || strcmp(topic, APP_MQTT_DOWN) || length >= M_MQTT_PAYLOAD_MAX) return;
        command_message_t message = {0};
        memcpy(message.payload, payload, length);
        if (xQueueSend(s_commands, &message, 0) != pdTRUE) {
            ESP_LOGW("app_mqtt", "Command queue full"); return;
        }
        event.id = EVT_MQTT_COMMAND;
    }
    event_post(&event);
}
static void timer_callback(void *arg)
{
    (void)arg;
    event_t event = {.id=EVT_MQTT_TICK}; event_post(&event);
}
static bool mqtt_root(hsm_t *hsm, const event_t *event)
{
    if (event->id == EVT_MQTT_STOP) {
        if (s_started) { m_mqtt_stop(); s_started = false; }
        esp_timer_stop(s_timer);
        xQueueReset(s_commands);
        hsm_transition(hsm, &offline); return true;
    }
    return false;
}
static bool offline_handler(hsm_t *hsm, const event_t *event)
{
    if (event->id != EVT_MQTT_START) return false;
    if (!s_sntp) {
        esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG("time.google.com");
        ESP_ERROR_CHECK(esp_netif_sntp_init(&config));
        s_sntp = true;
    }
    esp_timer_start_periodic(s_timer, 1000000);
    hsm_transition(hsm, &connecting);
    return true;
}
static bool connecting_handler(hsm_t *hsm, const event_t *event)
{
    if (event->id == EVT_MQTT_TICK && !s_started && time(NULL) > 1704067200) {
        if (m_mqtt_start() == ESP_OK) s_started = true;
        return true;
    }
    if (event->id == EVT_MQTT_CONNECTED) { hsm_transition(hsm, &online); return true; }
    return event->id == EVT_MQTT_DISCONNECTED || event->id == EVT_MQTT_START;
}
static void online_entry(hsm_t *hsm)
{
    (void)hsm;
    ESP_LOGI("app_mqtt", "ONLINE subscribe=%s", APP_MQTT_DOWN);
    m_mqtt_subscribe(APP_MQTT_DOWN, 1);
    publish_sample(NULL);
}
static bool online_handler(hsm_t *hsm, const event_t *event)
{
    if (event->id == EVT_MQTT_DISCONNECTED) { hsm_transition(hsm, &connecting); return true; }
    if (event->id == EVT_MQTT_COMMAND || event->id == EVT_MQTT_TICK) {
        command_message_t message;
        while (xQueueReceive(s_commands, &message, 0) == pdTRUE) dispatch_command(message.payload);
        if (event->id == EVT_MQTT_TICK && esp_timer_get_time()-s_last_publish >= (int64_t)s_cycle*1000000)
            publish_sample(NULL);
        return true;
    }
    return event->id == EVT_MQTT_START || event->id == EVT_MQTT_CONNECTED;
}
esp_err_t mqtt_hsm_init(void)
{
    nvs_handle_t handle;
    if (nvs_open("device", NVS_READONLY, &handle) == ESP_OK) {
        uint32_t cycle;
        if (nvs_get_u32(handle, "mqtt_cycle", &cycle) == ESP_OK && cycle >= 1 && cycle <= 86400) s_cycle = cycle;
        nvs_close(handle);
    }
    snprintf(s_boot_id, sizeof(s_boot_id), "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
    s_commands = xQueueCreate(8, sizeof(command_message_t));
    if (!s_commands) return ESP_ERR_NO_MEM;
    const esp_mqtt_client_config_t config = {
        .broker.address.uri = APP_MQTT_URI,
        .broker.verification.crt_bundle_attach = esp_crt_bundle_attach,
        .credentials.username = APP_MQTT_TOKEN,
        .credentials.client_id = "phwater-" DEVICE_ID,
        .session.keepalive = 30,
        .session.last_will = {.topic=APP_MQTT_UP, .msg="{\"type\":\"status\",\"device_id\":\"" DEVICE_ID "\",\"status\":\"offline\"}", .qos=1},
        .network.reconnect_timeout_ms = 5000,
        .buffer.size = 1024,
        .outbox.limit = 16384,
    };
    ESP_ERROR_CHECK(m_mqtt_init(&config, transport_callback, NULL));
    const esp_timer_create_args_t timer = {.callback=timer_callback, .name="mqtt_cycle"};
    ESP_ERROR_CHECK(esp_timer_create(&timer, &s_timer));
    hsm_init(&s_hsm, &offline);
    return ESP_OK;
}
void mqtt_hsm_start(void) { event_t event = {.id=EVT_MQTT_START}; hsm_dispatch(&s_hsm, &event); }
void mqtt_hsm_stop(void) { event_t event = {.id=EVT_MQTT_STOP}; hsm_dispatch(&s_hsm, &event); }
void mqtt_hsm_dispatch(const event_t *event) { hsm_dispatch(&s_hsm, event); }
