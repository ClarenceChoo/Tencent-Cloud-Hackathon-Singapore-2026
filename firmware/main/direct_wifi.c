#include "careloop_app.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "cJSON.h"
#include "driver/gpio.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_random.h"
#include "esp_sntp.h"
#include "esp_timer.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "careloop_wav.h"
#include "careloop_direct_receipt.h"

#define CLOUD_API_ROOT "/api/voice/device"
#define CLOUD_RESPONSE_MAX 8192U
#define CLOUD_CHUNK_FRAMES 16000U
#define CLOUD_POLL_MS 1200U

typedef struct { char *data; size_t length; bool overflow; } cloud_response_t;
typedef struct { char command_id[37]; char claim_id[37]; char kind[16]; } relay_job_t;
static careloop_app_t *device;
static QueueHandle_t relay_queue;
static uint8_t *retained_wav;
static size_t retained_len;
static char retained_recording_id[37];
static SemaphoreHandle_t clip_lock;
static SemaphoreHandle_t status_lock;
static bool busy;
static char phase[32]="idle";
static char phase_message[160]="Ready";

static void uuid(char out[37]) {
  uint8_t bytes[16]; esp_fill_random(bytes, sizeof(bytes));
  bytes[6]=(uint8_t)((bytes[6]&0x0fU)|0x40U);
  bytes[8]=(uint8_t)((bytes[8]&0x3fU)|0x80U);
  size_t at=0;
  for(size_t i=0;i<sizeof(bytes);i++){
    if(i==4||i==6||i==8||i==10)out[at++]='-';
    at+=(size_t)snprintf(out+at,37-at,"%02x",bytes[i]);
  }
  out[36]=0;
}
static bool safe_uuid(const char *s) {
  if (!s || strlen(s) != 36) return false;
  for (size_t i=0;i<36;i++) if (i==8||i==13||i==18||i==23 ? s[i]!='-' : !isxdigit((unsigned char)s[i])) return false;
  return true;
}
static bool response_init(cloud_response_t *r) { memset(r,0,sizeof(*r)); r->data=calloc(1,CLOUD_RESPONSE_MAX+1); return r->data!=NULL; }
static esp_err_t response_event(esp_http_client_event_t *event) {
  cloud_response_t *response=event->user_data;
  if(event->event_id==HTTP_EVENT_ON_DATA && response) {
    if(response->length+(size_t)event->data_len>CLOUD_RESPONSE_MAX){response->overflow=true;return ESP_FAIL;}
    memcpy(response->data+response->length,event->data,(size_t)event->data_len);
    response->length+=(size_t)event->data_len;response->data[response->length]=0;
  }
  return ESP_OK;
}
static esp_err_t cloud_request(const char *path, esp_http_client_method_t method,
                              const void *body, size_t body_len, const char *content_type,
                              cloud_response_t *response, int *http_status) {
  if(!device||!path||path[0]!='/'||!device->settings.device_token[0]||!safe_uuid(device->settings.room_id))return ESP_ERR_INVALID_STATE;
  char url[CARELOOP_URL_MAX+128];
  if(snprintf(url,sizeof(url),"%s%s%s",device->settings.backend_url,CLOUD_API_ROOT,path)>=(int)sizeof(url))return ESP_ERR_INVALID_SIZE;
  const int timeout_ms=strstr(path,"/finish")?65000:12000;
  esp_http_client_config_t config={.url=url,.event_handler=response_event,.user_data=response,
    .timeout_ms=timeout_ms,.crt_bundle_attach=esp_crt_bundle_attach,.keep_alive_enable=true,.disable_auto_redirect=true};
  esp_http_client_handle_t client=esp_http_client_init(&config);if(!client)return ESP_FAIL;
  char authorization[96];int n=snprintf(authorization,sizeof(authorization),"Bearer %s",device->settings.device_token);
  if(n<0||n>=(int)sizeof(authorization)){esp_http_client_cleanup(client);memset(authorization,0,sizeof(authorization));return ESP_ERR_INVALID_SIZE;}
  esp_http_client_set_method(client,method);esp_http_client_set_header(client,"Authorization",authorization);
  esp_http_client_set_header(client,"Accept","application/json");
  if(content_type)esp_http_client_set_header(client,"Content-Type",content_type);
  if(body&&body_len)esp_http_client_set_post_field(client,(const char*)body,(int)body_len);
  memset(authorization,0,sizeof(authorization));
  esp_err_t error=esp_http_client_perform(client);
  int status=esp_http_client_get_status_code(client);if(http_status)*http_status=status;
  if(response&&response->overflow)error=ESP_ERR_INVALID_SIZE;
  esp_http_client_cleanup(client);return error;
}
static esp_err_t cloud_json(const char *path, esp_http_client_method_t method, cJSON *body,
                            cloud_response_t *response, int *status) {
  char *data=body?cJSON_PrintUnformatted(body):NULL;
  if(body&&!data)return ESP_ERR_NO_MEM;
  esp_err_t result=cloud_request(path,method,data,data?strlen(data):0,"application/json",response,status);
  if(data){memset(data,0,strlen(data));cJSON_free(data);}return result;
}
static void update_phase(const char *next, const char *message) {
  if(status_lock)xSemaphoreTake(status_lock,portMAX_DELAY);
  snprintf(phase,sizeof(phase),"%s",next?next:"idle");
  snprintf(phase_message,sizeof(phase_message),"%s",message?message:"");
  if(status_lock)xSemaphoreGive(status_lock);
}
static void set_connection_status(const char *state, const char *code, const char *message) {
  bool changed=strcmp(device->wifi_state,state?state:"") || strcmp(device->wifi_code,code?code:"") || strcmp(device->wifi_message,message?message:"");
  if(changed)careloop_wifi_status(device,state,code,message);
}
static bool json_string(cJSON *object,const char *key,char *out,size_t cap) {
  cJSON *value=cJSON_GetObjectItemCaseSensitive(object,key);
  if(!cJSON_IsString(value)||!value->valuestring||strlen(value->valuestring)>=cap)return false;
  snprintf(out,cap,"%s",value->valuestring);return true;
}
static esp_err_t api_room(bool claim, char *state, size_t state_cap, char *code, size_t code_cap, int *status) {
  cloud_response_t response;if(!response_init(&response))return ESP_ERR_NO_MEM;
  char path[64];snprintf(path,sizeof(path),"/rooms/%s%s",device->settings.room_id,claim?"/claim":"");
  cJSON *body=NULL;
  if(claim){body=cJSON_CreateObject();if(body)cJSON_AddStringToObject(body,"token",device->settings.pairing_token);}
  esp_err_t error=cloud_json(path,claim?HTTP_METHOD_POST:HTTP_METHOD_GET,body,&response,status);if(body)cJSON_Delete(body);
  if(error==ESP_OK&&status&&(*status==200||*status==201)&&!response.overflow){
    cJSON *root=cJSON_Parse(response.data),*room=root?cJSON_GetObjectItemCaseSensitive(root,"room"):NULL;
    bool valid=cJSON_IsObject(room)&&json_string(room,"id",path,sizeof(path))&&!strcmp(path,device->settings.room_id)&&json_string(room,"state",state,state_cap);
    cJSON *code_value=room?cJSON_GetObjectItemCaseSensitive(room,"code"):NULL;
    if(cJSON_IsString(code_value)&&code_value->valuestring&&strlen(code_value->valuestring)<code_cap)snprintf(code,code_cap,"%s",code_value->valuestring);
    else code[0]=0;
    if(!valid)error=ESP_ERR_INVALID_RESPONSE;
    if(root)cJSON_Delete(root);
  }else if(error==ESP_OK)error=ESP_FAIL;
  free(response.data);return error;
}
static bool relay_status_json(cJSON *root) {
  if(!root)return false;
  xSemaphoreTake(device->state_lock,portMAX_DELAY);
  if(clip_lock)xSemaphoreTake(clip_lock,portMAX_DELAY);
  if(status_lock)xSemaphoreTake(status_lock,portMAX_DELAY);
  cJSON_AddBoolToObject(root,"busy",busy);
  cJSON_AddBoolToObject(root,"hardwareReady",careloop_board_microphone_ready(&device->board));
  cJSON_AddBoolToObject(root,"canRetry",retained_wav!=NULL&&!busy);
  cJSON_AddStringToObject(root,"phase",phase);
  cJSON_AddStringToObject(root,"message",phase_message);
  cJSON_AddStringToObject(root,"transport","Wi-Fi");
  if(status_lock)xSemaphoreGive(status_lock);
  if(clip_lock)xSemaphoreGive(clip_lock);
  xSemaphoreGive(device->state_lock);return true;
}
static esp_err_t relay_request(const char *action,const char *command_id,const char *claim_id,cJSON **reply,int *http_status) {
  cloud_response_t response;if(!response_init(&response))return ESP_ERR_NO_MEM;
  cJSON *body=cJSON_CreateObject();if(!body){free(response.data);return ESP_ERR_NO_MEM;}
  relay_status_json(body);
  if(action&&action[0])cJSON_AddStringToObject(body,"action",action);
  if(command_id)cJSON_AddStringToObject(body,"commandId",command_id);
  if(claim_id)cJSON_AddStringToObject(body,"claimId",claim_id);
  char path[64];snprintf(path,sizeof(path),"/rooms/%s/relay",device->settings.room_id);
  int status=0;esp_err_t error=cloud_json(path,HTTP_METHOD_POST,body,&response,&status);cJSON_Delete(body);
  if(http_status)*http_status=status;
  if(error==ESP_OK&&status>=200&&status<300){cJSON *parsed=cJSON_Parse(response.data);if(reply)*reply=parsed;else if(parsed)cJSON_Delete(parsed);if(reply&&!parsed)error=ESP_ERR_INVALID_RESPONSE;}
  else if(error==ESP_OK)error=ESP_FAIL;
  free(response.data);return error;
}
static esp_err_t mark_receipt(const char *command,const char *claim,const char *kind,const char *state) {
  if(device->state_lock)xSemaphoreTake(device->state_lock,portMAX_DELAY);
  careloop_settings_t next=device->settings;
  snprintf(next.relay_command_id,sizeof(next.relay_command_id),"%s",command?command:"");
  snprintf(next.relay_claim_id,sizeof(next.relay_claim_id),"%s",claim?claim:"");
  snprintf(next.relay_kind,sizeof(next.relay_kind),"%s",kind?kind:"");
  snprintf(next.relay_receipt_state,sizeof(next.relay_receipt_state),"%s",state?state:"");
  if(careloop_settings_save(&next)!=ESP_OK){if(device->state_lock)xSemaphoreGive(device->state_lock);return ESP_FAIL;}
  device->settings=next;
  if(device->state_lock)xSemaphoreGive(device->state_lock);
  return ESP_OK;
}
static void relay_terminal(bool success) {
  if(!device->settings.relay_command_id[0]||!device->settings.relay_claim_id[0])return;
  const char *pending=success?"complete_pending":"failed_pending";
  if(strcmp(device->settings.relay_receipt_state,pending)&&mark_receipt(device->settings.relay_command_id,device->settings.relay_claim_id,device->settings.relay_kind,pending)!=ESP_OK)return;
  int status=0;esp_err_t error=relay_request(success?"complete":"failed",device->settings.relay_command_id,device->settings.relay_claim_id,NULL,&status);
  if((error==ESP_OK&&status>=200&&status<300)||careloop_terminal_receipt_resolved(status))
    mark_receipt(device->settings.relay_command_id,device->settings.relay_claim_id,device->settings.relay_kind,success?"complete":"failed");
}
static bool parse_pending_command(cJSON *root,relay_job_t *job) {
  cJSON *command=cJSON_GetObjectItemCaseSensitive(root,"command");if(!cJSON_IsObject(command))return false;
  char state[16]={0};if(!json_string(command,"id",job->command_id,sizeof(job->command_id))||!safe_uuid(job->command_id)||
    !json_string(command,"kind",job->kind,sizeof(job->kind))||!json_string(command,"state",state,sizeof(state)))return false;
  return (!strcmp(job->kind,"capture")||!strcmp(job->kind,"retry"))&&!strcmp(state,"queued");
}
static void fail_or_recover_receipt(void) {
  const char *state=device->settings.relay_receipt_state;
  if(!device->settings.relay_command_id[0]||!device->settings.relay_claim_id[0])return;
  if(!strcmp(state,"started")){
    /* A restart may have interrupted capture or transfer. Never record again. */
    update_phase("error","The previous recording stopped when the device restarted. No new clip was made.");
    if(mark_receipt(device->settings.relay_command_id,device->settings.relay_claim_id,device->settings.relay_kind,"failed_pending")==ESP_OK)relay_terminal(false);
  }else if(!strcmp(state,"claiming")){
    cJSON *reply=NULL;
    if(relay_request("claim",device->settings.relay_command_id,device->settings.relay_claim_id,&reply,NULL)==ESP_OK){
      cJSON *claimed=reply?cJSON_GetObjectItemCaseSensitive(reply,"claimed"):NULL;
      if(cJSON_IsTrue(claimed)&&mark_receipt(device->settings.relay_command_id,device->settings.relay_claim_id,device->settings.relay_kind,"started")==ESP_OK){
        relay_job_t job={0};snprintf(job.command_id,sizeof(job.command_id),"%s",device->settings.relay_command_id);snprintf(job.claim_id,sizeof(job.claim_id),"%s",device->settings.relay_claim_id);snprintf(job.kind,sizeof(job.kind),"%s",device->settings.relay_kind);
        if(xQueueSend(relay_queue,&job,0)!=pdTRUE)relay_terminal(false);
      }
      if(reply)cJSON_Delete(reply);
    }
  }else if(!strcmp(state,"complete_pending"))relay_terminal(true);
  else if(!strcmp(state,"failed_pending"))relay_terminal(false);
}
static void handle_remote_command(cJSON *root) {
  relay_job_t job={0};if(!parse_pending_command(root,&job))return;
  if(!strcmp(device->settings.relay_command_id,job.command_id)){
    if(!strcmp(device->settings.relay_receipt_state,"claiming")){fail_or_recover_receipt();return;}
    /* A durable started or terminal receipt suppresses any duplicate capture. */
    return;
  }
  if(busy)return;
  if(!strcmp(job.kind,"retry")&&retained_wav==NULL){
    /* Retry is only for the exact PCM still held in RAM; reboot loses it. */
    uuid(job.claim_id);
    if(mark_receipt(job.command_id,job.claim_id,job.kind,"claiming")!=ESP_OK)return;
    cJSON *reply=NULL;esp_err_t e=relay_request("claim",job.command_id,job.claim_id,&reply,NULL);
    bool claimed=reply&&cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(reply,"claimed"));if(reply)cJSON_Delete(reply);
    if(e==ESP_OK&&claimed&&mark_receipt(job.command_id,job.claim_id,job.kind,"started")==ESP_OK){update_phase("error","The previous clip is no longer in memory. Record a new clip to continue.");relay_terminal(false);}
    return;
  }
  uuid(job.claim_id);
  if(mark_receipt(job.command_id,job.claim_id,job.kind,"claiming")!=ESP_OK)return;
  cJSON *reply=NULL;esp_err_t error=relay_request("claim",job.command_id,job.claim_id,&reply,NULL);
  bool claimed=reply&&cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(reply,"claimed"));if(reply)cJSON_Delete(reply);
  if(error!=ESP_OK||!claimed)return; /* The stored claiming receipt retries with this same claim ID. */
  if(mark_receipt(job.command_id,job.claim_id,job.kind,"started")!=ESP_OK){relay_request("failed",job.command_id,job.claim_id,NULL,NULL);return;}
  if(xQueueSend(relay_queue,&job,0)!=pdTRUE){update_phase("error","The recording request could not start. Try again from the dashboard.");relay_terminal(false);}
}
static void perform_upload(void) {
  xSemaphoreTake(clip_lock,portMAX_DELAY);
  if(!retained_wav||!retained_recording_id[0]){xSemaphoreGive(clip_lock);update_phase("error","There is no clip in memory to retry. Record a new clip.");return;}
  uint8_t *wav=retained_wav;size_t wav_len=retained_len;char recording_id[37];snprintf(recording_id,sizeof(recording_id),"%s",retained_recording_id);
  xSemaphoreGive(clip_lock);
  update_phase("uploading","Sending the recording to Parse over Wi-Fi.");
  char path[96];snprintf(path,sizeof(path),"/recordings");cJSON *body=cJSON_CreateObject();if(!body){relay_terminal(false);return;}
  cJSON_AddStringToObject(body,"roomId",device->settings.room_id);cJSON_AddStringToObject(body,"recordingId",recording_id);
  bool created=false;for(unsigned attempt=0;attempt<3&&!created;attempt++){
    cloud_response_t response;if(!response_init(&response))break;int status=0;
    esp_err_t e=cloud_json(path,HTTP_METHOD_POST,body,&response,&status);
    created=e==ESP_OK&&(status==200||status==201);free(response.data);
    if(!created)vTaskDelay(pdMS_TO_TICKS(300U<<attempt));
  }
  cJSON_Delete(body);if(!created){update_phase("error","Parse did not accept the recording yet. The clip is kept in memory; choose retry.");relay_terminal(false);return;}
  uint32_t frames=(uint32_t)((wav_len-44)/2),sequence=0;bool uploaded=true;
  for(uint32_t at=0;at<frames;at+=CLOUD_CHUNK_FRAMES,sequence++){
    uint32_t count=frames-at;if(count>CLOUD_CHUNK_FRAMES)count=CLOUD_CHUNK_FRAMES;
    size_t chunk_len=44U+(size_t)count*2U;uint8_t *chunk=malloc(chunk_len);if(!chunk){uploaded=false;break;}
    memcpy(chunk+44,wav+44+(size_t)at*2U,(size_t)count*2U);careloop_wav_write_header(chunk,(uint32_t)((size_t)count*2U));
    snprintf(path,sizeof(path),"/recordings/%s/chunks/%lu",recording_id,(unsigned long)sequence);
    bool sent=false;for(unsigned attempt=0;attempt<3&&!sent;attempt++){
      cloud_response_t response;if(!response_init(&response))break;int status=0;
      esp_err_t e=cloud_request(path,HTTP_METHOD_POST,chunk,chunk_len,"audio/wav",&response,&status);
      sent=e==ESP_OK&&(status>=200&&status<300);free(response.data);if(!sent)vTaskDelay(pdMS_TO_TICKS(250U<<attempt));
    }
    free(chunk);if(!sent){uploaded=false;break;}
  }
  if(!uploaded){update_phase("error","A recording segment could not be confirmed. The same clip is kept for retry.");relay_terminal(false);return;}
  update_phase("interpreting","Parse is transcribing and preparing its response.");
  snprintf(path,sizeof(path),"/recordings/%s/finish",recording_id);body=cJSON_CreateObject();if(!body){relay_terminal(false);return;}cJSON_AddNumberToObject(body,"chunks",sequence);
  bool finished=false;for(unsigned attempt=0;attempt<3&&!finished;attempt++){
    cloud_response_t response;if(!response_init(&response))break;int status=0;
    esp_err_t e=cloud_json(path,HTTP_METHOD_POST,body,&response,&status);
    finished=e==ESP_OK&&(status>=200&&status<300);free(response.data);if(!finished)vTaskDelay(pdMS_TO_TICKS(500U<<attempt));
  }
  cJSON_Delete(body);
  if(!finished){update_phase("error","Parse has not confirmed the result. The same recording can be retried.");relay_terminal(false);return;}
  xSemaphoreTake(clip_lock,portMAX_DELAY);free(retained_wav);retained_wav=NULL;retained_len=0;retained_recording_id[0]=0;xSemaphoreGive(clip_lock);
  update_phase("complete","Recording sent. Open Parse to review the transcript and response.");relay_terminal(true);
}
static void capture_and_send(bool timed,relay_job_t *job) {
  if(xSemaphoreTake(device->audio_lock,pdMS_TO_TICKS(100))!=pdTRUE){update_phase("error","Audio is busy. Try again when the current playback has finished.");if(job)relay_terminal(false);return;}
  xSemaphoreTake(clip_lock,portMAX_DELAY);bool have_clip=retained_wav!=NULL;xSemaphoreGive(clip_lock);
  if(have_clip){update_phase("error","An earlier clip is still waiting to send. Choose retry before recording again.");xSemaphoreGive(device->audio_lock);if(job)relay_terminal(false);return;}
  xSemaphoreTake(device->state_lock,portMAX_DELAY);busy=true;xSemaphoreGive(device->state_lock);update_phase(timed?"countdown":"recording",timed?"Starting the requested 6-second recording.":"Recording while the talk button is held.");
  if(timed){
    for(int tick=3;tick>0;tick--){vTaskDelay(pdMS_TO_TICKS(1000));}
  }
  uint8_t *wav=NULL;size_t wav_len=0;esp_err_t result=timed?careloop_capture_wav_timed(&device->board,6000,&wav,&wav_len):careloop_capture_wav(&device->board,&wav,&wav_len);
  if(result!=ESP_OK){update_phase("error",result==ESP_ERR_INVALID_SIZE?"The clip was too short. Hold the talk button longer or try again.":"The microphone could not capture audio.");xSemaphoreGive(device->audio_lock);xSemaphoreTake(device->state_lock,portMAX_DELAY);busy=false;xSemaphoreGive(device->state_lock);if(job)relay_terminal(false);return;}
  char id[37];uuid(id);xSemaphoreTake(clip_lock,portMAX_DELAY);retained_wav=wav;retained_len=wav_len;snprintf(retained_recording_id,sizeof(retained_recording_id),"%s",id);xSemaphoreGive(clip_lock);
  xSemaphoreGive(device->audio_lock);perform_upload();xSemaphoreTake(device->state_lock,portMAX_DELAY);busy=false;xSemaphoreGive(device->state_lock);
}
static void retry_and_send(relay_job_t *job) {
  (void)job;
  xSemaphoreTake(device->state_lock,portMAX_DELAY);busy=true;xSemaphoreGive(device->state_lock);
  perform_upload();
  xSemaphoreTake(device->state_lock,portMAX_DELAY);busy=false;xSemaphoreGive(device->state_lock);
}
static void direct_worker(void *arg) {
  (void)arg;bool claim_checked=false;char cloud_state[16]={0},cloud_code[8]={0};int64_t next_room_check=0;bool receipt_recovered=false;
  while(1){
    if(!device->settings.room_id[0]){
      set_connection_status("unconfigured",NULL,"Connect Parse and configure this ESP32 from the USB setup panel.");
      update_phase("idle","Waiting for Wi-Fi setup over USB.");
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    if(!careloop_wifi_connected()){
      set_connection_status("offline",NULL,"Waiting for the saved hotspot. Parse will reconnect automatically.");
      update_phase("connecting","Joining the saved hotspot.");vTaskDelay(pdMS_TO_TICKS(1000));continue;
    }
    if(time(NULL)<1700000000){
      set_connection_status("connecting",NULL,"Connected to Wi-Fi. Waiting for secure internet time.");
      update_phase("time_sync","Waiting for network time before opening secure Parse connection.");
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    careloop_receipt_action_t receipt_action=careloop_receipt_action(device->settings.relay_receipt_state,receipt_recovered);
    if(receipt_action==CARELOOP_RECEIPT_RETRY_CLAIM){fail_or_recover_receipt();if(!strcmp(device->settings.relay_receipt_state,"started"))receipt_recovered=true;}
    else if(receipt_action==CARELOOP_RECEIPT_RETRY_COMPLETE||receipt_action==CARELOOP_RECEIPT_RETRY_FAILED)fail_or_recover_receipt();
    else if(receipt_action==CARELOOP_RECEIPT_FAIL_INTERRUPTED){fail_or_recover_receipt();receipt_recovered=true;}
    else if(!receipt_recovered)receipt_recovered=true;
    int64_t now=esp_timer_get_time();
    if(now>=next_room_check){
      bool claim=device->settings.pairing_token[0]!=0;
      char room_state[16]={0},room_code[8]={0};int status=0;
      esp_err_t result=api_room(claim,room_state,sizeof(room_state),room_code,sizeof(room_code),&status);
      if(result==ESP_OK){
        if(claim){memset(device->settings.pairing_token,0,sizeof(device->settings.pairing_token));careloop_settings_save(&device->settings);}
        snprintf(cloud_state,sizeof(cloud_state),"%s",room_state);snprintf(cloud_code,sizeof(cloud_code),"%s",room_code);
        if(!strcmp(room_state,"paired")){set_connection_status("ready",NULL,"Connected to Parse. Ready for a dashboard request or talk-button recording.");}
        else if(!strcmp(room_state,"pending")){set_connection_status("awaiting_approval",room_code,"Compare this code with the Parse dashboard and approve the ESP32.");}
        else {set_connection_status("error",NULL,"The Parse connection is no longer available. Reconnect from the dashboard.");}
        claim_checked=true;
      }else if(status==409||status==401||status==403){
        set_connection_status("error",NULL,"Parse rejected this pairing. Use the dashboard to set up this ESP32 again.");
      }else set_connection_status("offline",NULL,"Could not reach Parse. Checking the hotspot and retrying.");
      next_room_check=now+(claim_checked?15000000LL:3000000LL);
    }
    if(claim_checked&&!strcmp(cloud_state,"paired")){
      cJSON *reply=NULL;
      if(relay_request(NULL,NULL,NULL,&reply,NULL)==ESP_OK&&reply){handle_remote_command(reply);cJSON_Delete(reply);}
      else set_connection_status("offline",NULL,"Hotspot is connected, but Parse is not responding yet. Retrying.");
    }
    vTaskDelay(pdMS_TO_TICKS(CLOUD_POLL_MS));
  }
}
void careloop_direct_start(careloop_app_t *app) {
  device=app;clip_lock=xSemaphoreCreateMutex();status_lock=xSemaphoreCreateMutex();relay_queue=xQueueCreate(3,sizeof(relay_job_t));
  if(!clip_lock||!status_lock||!relay_queue){careloop_wifi_status(app,"error",NULL,"Could not start the Wi-Fi voice service.");return;}
  esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);esp_sntp_setservername(0,"pool.ntp.org");esp_sntp_init();
  xTaskCreate(direct_worker,"parse_cloud_relay",6144,NULL,5,NULL);
}
bool careloop_direct_busy(void) {
  if(!device||!device->state_lock)return false;
  xSemaphoreTake(device->state_lock,portMAX_DELAY);bool active=busy;xSemaphoreGive(device->state_lock);return active;
}
void careloop_direct_interaction_task(void *arg) {
  careloop_app_t *app=arg;relay_job_t remote;
  for(;;){
    if(xQueueReceive(relay_queue,&remote,0)==pdTRUE){
      if(!strcmp(remote.kind,"retry"))retry_and_send(&remote);else capture_and_send(true,&remote);
      continue;
    }
    if(!careloop_ptt_pressed(&app->board)){vTaskDelay(pdMS_TO_TICKS(25));continue;}
    vTaskDelay(pdMS_TO_TICKS(40));if(!careloop_ptt_pressed(&app->board))continue;
    if(strcmp(app->wifi_state,"ready")||!careloop_wifi_connected()){vTaskDelay(pdMS_TO_TICKS(500));continue;}
    relay_job_t *none=NULL;capture_and_send(false,none);
    while(careloop_ptt_pressed(&app->board))vTaskDelay(pdMS_TO_TICKS(10));
  }
}
