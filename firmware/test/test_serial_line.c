#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <string.h>
#include <unistd.h>
#include "careloop_serial_line.h"

static void append(FILE *f,const void *bytes,size_t length) {
  off_t end=lseek(fileno(f),0,SEEK_END);
  /* Preserve the reader's offset while adding UART-like arriving bytes. */
  assert(end>=0);assert(pwrite(fileno(f),bytes,length,end)==(ssize_t)length);
  assert(lseek(fileno(f),end,SEEK_SET)==end);
}
int main(int argc,char **argv) {
  assert(argc==2);FILE *f=tmpfile();assert(f);setvbuf(f,NULL,_IONBF,0);
  careloop_serial_line_t state={0};
  assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_IDLE);
  if(!strcmp(argv[1],"idle_and_fragmented")){
    append(f,"{",1);assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_WAIT);
    for(int i=0;i<20;i++)assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_IDLE);
    append(f,"}\r\n",3);
    assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_WAIT);
    assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_WAIT);
    assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_READY);
    assert(!strcmp(state.line,"{}"));
  } else if(!strcmp(argv[1],"oversize_recovery")){
    char bytes[CARELOOP_SERIAL_LINE_MAX+2];memset(bytes,'x',sizeof(bytes));bytes[sizeof(bytes)-1]='\n';append(f,bytes,sizeof(bytes));
    for(size_t i=0;i<sizeof(bytes)-1;i++)assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_WAIT);
    assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_REJECTED);
    append(f,"ok\n",3);careloop_serial_poll(f,&state);careloop_serial_poll(f,&state);
    assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_READY&&!strcmp(state.line,"ok"));
  } else if(!strcmp(argv[1],"nul_rejected")){
    const char bytes[]={'{','}',0,'\n'};append(f,bytes,sizeof(bytes));
    for(size_t i=0;i<3;i++)assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_WAIT);
    assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_REJECTED);
  } else {
    char bytes[CARELOOP_SERIAL_LINE_MAX+1];memset(bytes,'x',sizeof(bytes));bytes[sizeof(bytes)-1]='\n';append(f,bytes,sizeof(bytes));
    for(size_t i=0;i<sizeof(bytes)-1;i++)assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_WAIT);
    assert(careloop_serial_poll(f,&state)==CARELOOP_SERIAL_READY&&strlen(state.line)==CARELOOP_SERIAL_LINE_MAX);
  }
  fclose(f);return 0;
}
