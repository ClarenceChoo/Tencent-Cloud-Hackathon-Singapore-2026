/* Exercise the real Wi-Fi capture implementation with distinct I2S channels. */
#include <assert.h>
#define CONFIG_CARELOOP_DIRECT_WIFI 1
#include "../main/board_audio.c"

static size_t input_frames, release_frame = SIZE_MAX;
static bool running, malformed, read_error;
static int64_t now;

int gpio_set_level(int p,int v) { (void)p;(void)v;return ESP_OK; }
int gpio_get_level(int p) { (void)p;return input_frames >= release_frame; }
int gpio_set_direction(int p,int m) { (void)p;(void)m;return ESP_OK; }
int gpio_set_pull_mode(int p,int m) { (void)p;(void)m;return ESP_OK; }
int i2s_driver_install(int n,const i2s_config_t*c,int q,void*p) {
  (void)q;(void)p;
  if(n==0)assert(c->channel_format==I2S_CHANNEL_FMT_RIGHT_LEFT);
  return ESP_OK;
}
int i2s_set_pin(int n,const i2s_pin_config_t*p) { (void)n;(void)p;return ESP_OK; }
int i2s_stop(int n) { if(n==0)running=false;return ESP_OK; }
int i2s_start(int n) { if(n==0)running=true;return ESP_OK; }
int i2s_zero_dma_buffer(int n) { (void)n;return ESP_OK; }
int i2s_read(int n,void*p,size_t c,size_t*g,unsigned t) {
  (void)t;assert(n==0&&running);
  if(read_error){*g=0;return ESP_FAIL;}
  if(malformed){*g=4;return ESP_OK;}
  int32_t *slots=p;
  for(size_t i=0;i<c/sizeof(*slots);i+=2) {
    /* The first 200 ms must be discarded; right-channel data must never leak. */
    slots[i]=(input_frames<3200?12345:1200)<<16;
    slots[i+1]=28000<<16;
    input_frames++;
  }
  *g=c;now+=(int64_t)(c/8)*1000000/16000;return ESP_OK;
}
int i2s_write(int n,const void*p,size_t c,size_t*w,unsigned t) {
  (void)n;(void)p;(void)c;(void)w;(void)t;return ESP_FAIL;
}
void *heap_caps_malloc(unsigned n,unsigned f) { (void)f;return malloc(n); }
int64_t esp_timer_get_time(void) { return now; }
void vTaskDelay(unsigned t) { now+=(int64_t)t*1000; }

int main(int argc,char **argv) {
  assert(argc==2);careloop_board_t b;assert(careloop_board_init(&b)==ESP_OK);
  bool timed=!strcmp(argv[1],"timed");
  if(!strcmp(argv[1],"release"))release_frame=16000;
  if(!strcmp(argv[1],"short"))release_frame=3264;
  if(!strcmp(argv[1],"malformed"))malformed=true;
  if(!strcmp(argv[1],"read_error"))read_error=true;
  uint8_t *wav=NULL;size_t size=0;
  esp_err_t result=timed?careloop_capture_wav_timed(&b,6000,&wav,&size):careloop_capture_wav(&b,&wav,&size);
  assert(!running);
  if(malformed||read_error||release_frame==3264){assert(result!=ESP_OK&&!wav);return 0;}
  assert(result==ESP_OK&&wav);
  size_t frames=(size-44)/2;
  assert(frames==(timed?96000:release_frame==16000?12800:320000));
  uint32_t bytes=0;assert(careloop_wav_header_valid(wav,&bytes)&&bytes==frames*2);
  int16_t expected=careloop_inmp441_to_pcm16(1200<<16);
  for(size_t i=44;i<size;i+=2)assert((int16_t)((uint16_t)wav[i]|((uint16_t)wav[i+1]<<8))==expected);
  free(wav);return 0;
}
