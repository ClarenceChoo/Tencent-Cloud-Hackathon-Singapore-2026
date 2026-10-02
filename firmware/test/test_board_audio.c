/* Compile the production translation unit; only the ESP-IDF boundary is fake. */
#include <assert.h>
#include <stdio.h>
static int test_mic_pin = 1;
#define CONFIG_CARELOOP_MIC_BCLK_GPIO test_mic_pin
#include "../main/board_audio.c"

static int mclk[2], writes, interrupt_at, fail_at;
static bool running, amp_on, partial;
static uint8_t fifo[3072];
static size_t queued, emitted_pcm, discarded_pcm;

int gpio_set_level(int p,int v) { if(p==7) amp_on=v!=0; return ESP_OK; }
int gpio_get_level(int p) { (void)p;return interrupt_at && writes>=interrupt_at ? 0 : 1; }
int gpio_set_direction(int p,int m) { (void)p;(void)m;return ESP_OK; }
int gpio_set_pull_mode(int p,int m) { (void)p;(void)m;return ESP_OK; }
int i2s_driver_install(int n,const i2s_config_t*c,int q,void*p) {
  (void)q;(void)p;
  if(n==1) assert(c->dma_buf_count*c->dma_buf_len*2==(int)sizeof(fifo));
  return ESP_OK;
}
int i2s_set_pin(int n,const i2s_pin_config_t*p) { mclk[n]=p->mck_io_num;return ESP_OK; }
int i2s_stop(int n) { if(n==1)running=false;return ESP_OK; }
int i2s_start(int n) { if(n==1)running=true;return ESP_OK; }
int i2s_zero_dma_buffer(int n) {
  if(n==1){for(size_t i=0;i<queued;i++)discarded_pcm+=fifo[i]!=0;queued=0;}
  return ESP_OK;
}
int i2s_write(int n,const void*p,size_t c,size_t*w,unsigned t) {
  (void)t;assert(n==1&&running&&amp_on);writes++;
  if(fail_at && writes>=fail_at){*w=0;return ESP_FAIL;}
  if(partial){*w=c/2;return ESP_OK;}
  const uint8_t *bytes=p;
  for(size_t i=0;i<c;i++) {
    if(queued==sizeof(fifo)) {
      emitted_pcm+=fifo[0]!=0;memmove(fifo,fifo+1,--queued);
    }
    fifo[queued++]=bytes[i];
  }
  *w=c;return ESP_OK;
}
int i2s_read(int n,void*p,size_t c,size_t*g,unsigned t) { (void)n;(void)p;(void)c;(void)t;*g=0;return ESP_OK; }
void *heap_caps_malloc(unsigned n,unsigned f) { (void)f;return malloc(n); }
int64_t esp_timer_get_time(void) { return 0; }
void vTaskDelay(unsigned t) { (void)t; }

int main(int argc,char **argv) {
  assert(argc==2);careloop_board_t b;
  if (!strncmp(argv[1], "psram_", 6)) test_mic_pin=atoi(argv[1]+6);
  if (!strncmp(argv[1], "usb_", 4)) test_mic_pin=atoi(argv[1]+4);
  if (!strcmp(argv[1], "invalid_pin")) test_mic_pin=23;
  if (!strcmp(argv[1], "duplicate_pin")) test_mic_pin=2;
  esp_err_t init=careloop_board_init(&b);
  if(test_mic_pin!=1){assert(init==ESP_ERR_INVALID_ARG);assert(!running);return 0;}
  assert(init==ESP_OK);
  if(!strcmp(argv[1],"mclk")){assert(mclk[0]==-1&&mclk[1]==-1);return 0;}
  uint8_t header[44],pcm[9600];memset(pcm,1,sizeof(pcm));careloop_wav_write_header(header,sizeof(pcm));
  if(!strcmp(argv[1],"interrupt"))interrupt_at=1;
  if(!strcmp(argv[1],"drain_interrupt"))interrupt_at=2;
  if(!strcmp(argv[1],"drain_error"))fail_at=2;
  if(!strcmp(argv[1],"partial_write"))partial=true;
  esp_err_t result=careloop_play_wav_stream(&b,header,pcm,sizeof(pcm),NULL,NULL);
  if(interrupt_at)assert(result==ESP_ERR_INVALID_STATE);
  else if(fail_at||partial)assert(result!=ESP_OK);
  else {assert(result==ESP_OK);assert(emitted_pcm==sizeof(pcm));assert(discarded_pcm==0);}
  assert(!running&&!amp_on);return 0;
}
