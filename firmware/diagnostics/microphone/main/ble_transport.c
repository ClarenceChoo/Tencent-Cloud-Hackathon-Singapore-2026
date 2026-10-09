#include <stdio.h>
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "careloop_wav.h"
#include "esp_heap_caps.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "mbedtls/gcm.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/sha256.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "nvs_flash.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

/* A fresh AES-GCM key is delivered over the physical USB link for each bench
 * session. Audio and commands cross BLE only in authenticated ciphertext.
 * Direction-specific nonces plus strictly increasing counters reject replays.
 * Keys expire after three minutes and are never stored in flash. */
static const ble_uuid128_t service_uuid = BLE_UUID128_INIT(
    0x59,0x2f,0xa4,0x9f,0xde,0x4e,0x2b,0xaa,0x26,0x42,0x50,0xb9,0x92,0xd4,0xba,0x91);
static const ble_uuid128_t rpc_uuid = BLE_UUID128_INIT(
    0x14,0xc8,0xac,0x78,0xec,0xdf,0xe2,0xac,0xce,0x48,0x6a,0x19,0x58,0x3a,0x56,0x0d);
static const ble_uuid128_t audio_uuid = BLE_UUID128_INIT(
    0x14,0xc8,0xac,0x78,0xec,0xdf,0xe2,0xac,0xce,0x48,0x6a,0x19,0x58,0x3a,0x56,0x1d);
static SemaphoreHandle_t lock;
static uint8_t own_type, key[32], response[256], mic_hash[32], reply_hash[32];
static size_t response_len, mic_len, reply_len, reply_received;
static uint8_t *mic, *reply;
static uint32_t sequence;
static uint32_t stream_counter;
static size_t stream_offset;
static uint16_t stream_handle;
static uint16_t connection = BLE_HS_CONN_HANDLE_NONE;
static int64_t expiry;
static bool synced, armed, requested, recording, subscribed, streaming;
static int gap_event(struct ble_gap_event *event, void *arg);

static void advertise(void) {
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = (ble_uuid128_t *)&service_uuid;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;
    if (ble_gap_adv_set_fields(&fields) != 0) return;
    struct ble_hs_adv_fields scan = {0};
    scan.name = (uint8_t *)"ParseAudio"; scan.name_len = 10; scan.name_is_complete = 1;
    ble_gap_adv_rsp_set_fields(&scan);
    struct ble_gap_adv_params params = {.conn_mode = BLE_GAP_CONN_MODE_UND, .disc_mode = BLE_GAP_DISC_MODE_GEN};
    int rc = ble_gap_adv_start(own_type, NULL, 180000, &params, gap_event, NULL);
    printf("BLE_ADVERTISING result=%d\n", rc);
}

static int gap_event(struct ble_gap_event *event, void *arg) {
    if (event->type == BLE_GAP_EVENT_CONNECT) {
        connection = event->connect.status == 0 ? event->connect.conn_handle : BLE_HS_CONN_HANDLE_NONE;
    } else if (event->type == BLE_GAP_EVENT_DISCONNECT) {
        connection = BLE_HS_CONN_HANDLE_NONE;
        subscribed = false; streaming = false;
        if (armed && esp_timer_get_time() < expiry) advertise();
    } else if (event->type == BLE_GAP_EVENT_SUBSCRIBE && event->subscribe.attr_handle == stream_handle) {
        subscribed = event->subscribe.cur_notify;
    }
    return 0;
}

static void nonce(uint8_t out[12], const char *direction, const uint8_t *counter) {
    memcpy(out, direction, 8); memcpy(out + 8, counter, 4);
}

static size_t execute(const uint8_t *in, size_t len, uint8_t *out) {
    out[0] = 0; /* Zero is success; payload begins at byte one. */
    if (len == 1 && in[0] == 1) {
        const char *text = "Parse ESP32-S3 BLE v1";
        memcpy(out + 1, text, strlen(text)); return 1 + strlen(text);
    }
    if (len == 1 && in[0] == 2) {
        if (recording || requested || streaming) { out[0] = 2; return 1; }
        free(mic); mic = NULL; mic_len = 0;
        requested = true; return 1;
    }
    if (len == 1 && in[0] == 3) {
        out[1] = (recording || requested) ? 1 : mic ? 2 : 0;
        uint32_t bytes = mic_len; memcpy(out + 2, &bytes, 4);
        memcpy(out + 6, mic_hash, 32); return 38;
    }
    if (len == 5 && in[0] == 4) {
        uint32_t offset; memcpy(&offset, in + 1, 4);
        if (!mic || offset >= mic_len) { out[0] = 3; return 1; }
        size_t count = mic_len - offset; if (count > 160) count = 160;
        memcpy(out + 1, mic + offset, count); return 1 + count;
    }
    if (len == 37 && in[0] == 5) {
        uint32_t size; memcpy(&size, in + 1, 4);
        if (size < 44 || size > 640044) { out[0] = 3; return 1; }
        free(reply); reply = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        reply_len = size; reply_received = 0; memcpy(reply_hash, in + 5, 32);
        if (!reply) out[0] = 4;
        return 1;
    }
    if (len > 5 && in[0] == 6) {
        uint32_t offset; memcpy(&offset, in + 1, 4);
        if (!reply || offset != reply_received || len - 5 > reply_len - reply_received) { out[0] = 3; return 1; }
        memcpy(reply + offset, in + 5, len - 5); reply_received += len - 5;
        return 1;
    }
    if (len == 1 && in[0] == 7) {
        uint8_t hash[32]; uint32_t pcm;
        if (!reply || reply_received != reply_len || mbedtls_sha256(reply, reply_len, hash, 0) != 0 ||
            memcmp(hash, reply_hash, 32) != 0 || careloop_wav_validate(reply, reply_len, &pcm) != CARELOOP_WAV_OK) {
            out[0] = 3; return 1;
        }
        memcpy(out + 1, hash, 32);
        printf("BLE_TTS_RECEIVED bytes=%u sha256_verified=yes playback=not_attempted\n", (unsigned)reply_len);
        free(reply); reply = NULL; reply_len = reply_received = 0;
        return 33;
    }
    if (len == 1 && in[0] == 8) {
        if (!mic || !subscribed || streaming) { out[0] = 2; return 1; }
        stream_offset = 0; streaming = true; return 1;
    }
    out[0] = 1; return 1;
}

static int access_rpc(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctx, void *arg) {
    if (xSemaphoreTake(lock, pdMS_TO_TICKS(100)) != pdTRUE) return BLE_ATT_ERR_UNLIKELY;
    if (!armed || esp_timer_get_time() >= expiry) {
        xSemaphoreGive(lock); return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
    }
    int result = BLE_ATT_ERR_UNLIKELY;
    if (ctx->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        result = response_len && os_mbuf_append(ctx->om, response, response_len) == 0 ? 0 : BLE_ATT_ERR_UNLIKELY;
    } else if (ctx->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t packet[256], plain[236], output[200], iv[12]; uint16_t size = 0;
        if (OS_MBUF_PKTLEN(ctx->om) >= 21 && OS_MBUF_PKTLEN(ctx->om) <= sizeof(packet) &&
            ble_hs_mbuf_to_flat(ctx->om, packet, sizeof(packet), &size) == 0) {
            uint32_t next; memcpy(&next, packet, 4);
            mbedtls_gcm_context aes; mbedtls_gcm_init(&aes);
            if (next > sequence && mbedtls_gcm_setkey(&aes, MBEDTLS_CIPHER_ID_AES, key, 256) == 0) {
                nonce(iv, "PARSE-RX", packet);
                if (mbedtls_gcm_auth_decrypt(&aes, size - 20, iv, sizeof(iv), NULL, 0,
                        packet + size - 16, 16, packet + 4, plain) == 0) {
                    sequence = next;
                    size_t produced = execute(plain, size - 20, output);
                    memcpy(response, packet, 4); nonce(iv, "PARSE-TX", packet);
                    if (mbedtls_gcm_crypt_and_tag(&aes, MBEDTLS_GCM_ENCRYPT, produced, iv, sizeof(iv),
                            NULL, 0, output, response + 4, 16, response + 4 + produced) == 0) {
                        response_len = produced + 20; result = 0;
                    }
                }
            }
            mbedtls_gcm_free(&aes);
        }
        mbedtls_platform_zeroize(plain, sizeof(plain));
    }
    xSemaphoreGive(lock); return result;
}

static const struct ble_gatt_svc_def services[] = {{
    .type = BLE_GATT_SVC_TYPE_PRIMARY, .uuid = &service_uuid.u,
    .characteristics = (struct ble_gatt_chr_def[]){{.uuid = &rpc_uuid.u, .access_cb = access_rpc,
        .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE},
        {.uuid = &audio_uuid.u, .access_cb = access_rpc, .flags = BLE_GATT_CHR_F_NOTIFY,
         .val_handle = &stream_handle}, {0}}
}, {0}};

static void sync_host(void) { if (ble_hs_id_infer_auto(0, &own_type) == 0) synced = true; }
static void host_task(void *unused) { nimble_port_run(); nimble_port_freertos_deinit(); }

void ble_bench_init(void) {
    lock = xSemaphoreCreateMutex();
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(nimble_port_init());
    ble_hs_cfg.sync_cb = sync_host;
    ble_svc_gap_init(); ble_svc_gatt_init();
    assert(ble_gatts_count_cfg(services) == 0);
    assert(ble_gatts_add_svcs(services) == 0);
    ble_svc_gap_device_name_set("ParseAudio");
    nimble_port_freertos_init(host_task);
}

void ble_bench_arm(void) {
    if (!synced || connection != BLE_HS_CONN_HANDLE_NONE) { puts("BLE_ERROR not_ready_or_connected"); return; }
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_fill_random(key, sizeof(key)); sequence = 0; stream_counter = 0; response_len = 0;
    expiry = esp_timer_get_time() + 180000000LL; armed = true;
    printf("BLE_ARM {\"key\":\"");
    for (unsigned i = 0; i < sizeof(key); ++i) printf("%02x", key[i]);
    puts("\",\"service\":\"91bad492-b950-4226-aa2b-4ede9fa42f59\"}"); fflush(stdout);
    xSemaphoreGive(lock);
    ble_gap_adv_stop(); advertise();
}

void ble_bench_tick(void) {
    if (armed && esp_timer_get_time() >= expiry) {
        xSemaphoreTake(lock, portMAX_DELAY);
        armed = false; response_len = 0; mbedtls_platform_zeroize(key, sizeof(key));
        free(mic); mic = NULL; mic_len = 0;
        free(reply); reply = NULL; reply_len = reply_received = 0;
        xSemaphoreGive(lock);
        ble_gap_adv_stop();
        if (connection != BLE_HS_CONN_HANDLE_NONE) ble_gap_terminate(connection, BLE_ERR_REM_USER_CONN_TERM);
    }
    for (unsigned sent = 0; sent < 4; ++sent) {
        uint8_t packet[500], plain[440], iv[12]; size_t count = 0;
        xSemaphoreTake(lock, portMAX_DELAY);
        if (!armed || !streaming || !subscribed || !mic || connection == BLE_HS_CONN_HANDLE_NONE) {
            xSemaphoreGive(lock); break;
        }
        int capacity = (int)ble_att_mtu(connection) - 27;
        if (capacity <= 0) { xSemaphoreGive(lock); break; }
        count = mic_len - stream_offset;
        if (count > 400) count = 400;
        if (count > (size_t)capacity) count = capacity;
        uint32_t counter = stream_counter + 1, offset = stream_offset;
        memcpy(packet, &counter, 4); memcpy(plain, &offset, 4);
        memcpy(plain + 4, mic + stream_offset, count);
        nonce(iv, "PARSE-AU", packet);
        mbedtls_gcm_context aes; mbedtls_gcm_init(&aes);
        int err = mbedtls_gcm_setkey(&aes, MBEDTLS_CIPHER_ID_AES, key, 256);
        if (!err) err = mbedtls_gcm_crypt_and_tag(&aes, MBEDTLS_GCM_ENCRYPT, count + 4, iv, sizeof(iv),
            NULL, 0, plain, packet + 4, 16, packet + count + 8);
        mbedtls_gcm_free(&aes);
        uint16_t target = connection;
        xSemaphoreGive(lock);
        if (err) break;
        struct os_mbuf *data = ble_hs_mbuf_from_flat(packet, count + 24);
        if (!data || ble_gatts_notify_custom(target, stream_handle, data) != 0) break;
        xSemaphoreTake(lock, portMAX_DELAY);
        stream_counter = counter; stream_offset += count;
        if (stream_offset == mic_len) streaming = false;
        xSemaphoreGive(lock);
    }
}

bool ble_bench_take_capture(void) {
    xSemaphoreTake(lock, portMAX_DELAY);
    bool take = requested; requested = false; if (take) recording = true;
    xSemaphoreGive(lock); return take;
}

void ble_bench_capture_result(uint8_t *wav, size_t bytes) {
    xSemaphoreTake(lock, portMAX_DELAY);
    free(mic); mic = wav; mic_len = bytes; recording = false;
    if (mic) mbedtls_sha256(mic, mic_len, mic_hash, 0);
    xSemaphoreGive(lock);
}
