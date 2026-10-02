/* JSON objects are constructed below; parsing/socket behavior is out of scope. */
#include <assert.h>
#include "../main/device_network.c"

static int saves,fail_save,plays,acks;
static bool persist_before_error;
static esp_err_t playback_result=ESP_OK;
static careloop_ledger_t durable;
static char last_ack[230];
static size_t read_offset;

int xSemaphoreTake(SemaphoreHandle_t p,unsigned t) { (void)p;(void)t;return pdTRUE; }
int xSemaphoreGive(SemaphoreHandle_t p) { (void)p;return pdTRUE; }
int careloop_ledger_save(const careloop_ledger_t*l) { if(++saves==fail_save){if(persist_before_error)durable=*l;return ESP_FAIL;}durable=*l;return ESP_OK; }
uint32_t esp_random(void) { return 0x12345678; }
int64_t esp_timer_get_time(void) { return 1000000; }
const char *esp_err_to_name(int e) { (void)e;return "injected error"; }
int esp_crt_bundle_attach(void *p) { (void)p;return ESP_OK; }
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t*c) { (void)c;read_offset=0;return (void*)1; }
int esp_http_client_cleanup(esp_http_client_handle_t h) { (void)h;return ESP_OK; }
int esp_http_client_set_method(esp_http_client_handle_t h,int m) { (void)h;(void)m;return ESP_OK; }
int esp_http_client_set_header(esp_http_client_handle_t h,const char*k,const char*v) { (void)h;(void)k;(void)v;return ESP_OK; }
int esp_http_client_set_post_field(esp_http_client_handle_t h,const char*b,int n) { (void)h;assert(n<(int)sizeof(last_ack));memcpy(last_ack,b,n);last_ack[n]=0;return ESP_OK; }
int esp_http_client_perform(esp_http_client_handle_t h) { (void)h;acks++;return ESP_OK; }
int esp_http_client_open(esp_http_client_handle_t h,int n) { (void)h;(void)n;return ESP_OK; }
int esp_http_client_fetch_headers(esp_http_client_handle_t h) { (void)h;return 9644; }
int esp_http_client_get_status_code(esp_http_client_handle_t h) { (void)h;return 200; }
int esp_http_client_close(esp_http_client_handle_t h) { (void)h;return ESP_OK; }
int esp_http_client_read(esp_http_client_handle_t h,char*b,int n) {
  (void)h;
  if(!read_offset){uint8_t header[44];careloop_wav_write_header(header,9600);assert(n==44);memcpy(b,header,44);read_offset=44;return 44;}
  memset(b,0,n);read_offset+=(size_t)n;return n;
}
esp_err_t careloop_play_wav_stream(const careloop_board_t*b,const uint8_t*h,const uint8_t*f,size_t n,int (*next)(void*,uint8_t*,size_t),void*c) {
  (void)b;(void)h;(void)f;(void)n;(void)next;(void)c;plays++;return playback_result;
}
esp_err_t careloop_play_local_prompt(const careloop_board_t*b,careloop_prompt_t p) { (void)b;(void)p;return ESP_OK; }

static void receipt(careloop_app_t *a,bool is_checkin) {
  cJSON fields[]={
    {.string="command_id",.type=cJSON_String,.valuestring="cmd_test"},
    {.string="context_id",.type=cJSON_String,.valuestring="ctx_test"},
    {.string="audio_path",.type=cJSON_String,.valuestring="/v1/device/audio/test"},
    {.string="plan_version",.type=cJSON_Number,.valuedouble=1},
  };
  for(size_t i=0;i<3;i++)fields[i].next=&fields[i+1];
  cJSON expiry={.string="expires_at",.type=cJSON_String,.valuestring="2099-01-01T00:00:00Z"};
  cJSON payload={.string="payload",.type=cJSON_Object,.child=fields,.next=&expiry};
  cJSON root={.type=cJSON_Object,.child=&payload};
  if(is_checkin)checkin(a,&root);else command(a,&root);
}

int main(int argc,char **argv) {
  assert(argc==2);careloop_app_t a={0};strcpy(a.settings.backend_url,"https://care.example");
  if(!strcmp(argv[1],"receipt_failure")||!strcmp(argv[1],"checkin_receipt_failure")) {
    fail_save=1;receipt(&a,!strcmp(argv[1],"checkin_receipt_failure"));
    assert(!a.pending.valid&&!a.checkin.valid&&acks==0);assert(!ledger_suppresses(&a,"cmd_test"));return 0;
  }
  if(strstr(argv[1],"context")) {
    a.pending_reply_count=1;strcpy(a.pending_reply_paths[0],"/v1/device/audio/test");
    a.pending_reply_context_present=true;strcpy(a.pending_reply_context_id,"ctx_new");
    a.pending_reply_expires_at=time(NULL)+60;playback_result=ESP_ERR_INVALID_STATE;
    if(!strcmp(argv[1],"null_context")){strcpy(a.context_id,"ctx_old");a.context_expires_at=time(NULL)+60;a.pending_reply_context_id[0]=0;}
    if(!strcmp(argv[1],"expired_context"))a.pending_reply_expires_at=time(NULL)-1;
    careloop_network_play_pending(&a);
    if(!strcmp(argv[1],"interrupted_context"))assert(!strcmp(a.context_id,"ctx_new"));
    else assert(a.context_id[0]==0);
    if(!strcmp(argv[1],"expired_context"))assert(plays==0);else assert(plays==1);
    assert(!a.pending_reply_count);return 0;
  }
  receipt(&a,false);assert(acks==1&&a.pending.valid);
  if(!strcmp(argv[1],"start_failure")||!strcmp(argv[1],"checkin_start_failure"))fail_save=2;
  if(!strcmp(argv[1],"terminal_failure")||!strcmp(argv[1],"checkin_terminal_failure")||!strcmp(argv[1],"reboot_suppression")||!strcmp(argv[1],"checkin_reboot_suppression")||!strcmp(argv[1],"uncertain_failure"))fail_save=3;
  if(!strcmp(argv[1],"uncertain_failure")){persist_before_error=true;playback_result=ESP_FAIL;}
  if(!strcmp(argv[1],"failed_audio_suppresses"))playback_result=ESP_FAIL;
  careloop_command_stage_t result;
  if(!strcmp(argv[1],"checkin_start_failure")||!strcmp(argv[1],"checkin_terminal_failure")||!strcmp(argv[1],"checkin_reboot_suppression")) {
    careloop_pending_checkin_t c={.count=1,.expires_at=time(NULL)+60};strcpy(c.command_id,"cmd_test");strcpy(c.paths[0],"/v1/device/audio/test");result=play_checkin(&a,&c);
  } else result=play_asset(&a,&a.pending);
  if(fail_save==2){assert(plays==0&&acks==1&&result!=CARELOOP_CMD_COMPLETED);}
  else if(fail_save==3){assert(plays==1&&acks==2&&result==CARELOOP_CMD_UNKNOWN);assert(careloop_ledger_find(&a.ledger,"cmd_test")->stage==CARELOOP_CMD_PLAYING);}
  else if(playback_result==ESP_FAIL){assert(plays==1&&acks==3&&result==CARELOOP_CMD_FAILED);assert(strstr(last_ack,"failed"));assert(careloop_ledger_should_suppress(careloop_ledger_find(&durable,"cmd_test")));}
  else {assert(plays==1&&acks==3&&result==CARELOOP_CMD_COMPLETED);assert(strstr(last_ack,"playback_completed"));}
  if(!strcmp(argv[1],"uncertain_failure")) {
    careloop_app_t reboot={0};reboot.ledger=durable;
    assert(ledger_suppresses(&reboot,"cmd_test"));
    int old_acks=acks;receipt(&reboot,false);assert(!reboot.pending.valid&&acks==old_acks);
  }
  if(!strcmp(argv[1],"reboot_suppression")||!strcmp(argv[1],"checkin_reboot_suppression")) {
    careloop_app_t reboot={0};reboot.ledger=durable;int old_acks=acks;assert(careloop_ledger_find(&reboot.ledger,"cmd_test")->stage==CARELOOP_CMD_PLAYING);receipt(&reboot,!strcmp(argv[1],"checkin_reboot_suppression"));assert(!reboot.pending.valid&&!reboot.checkin.valid&&acks==old_acks);
  }
  return 0;
}
