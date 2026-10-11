#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

#define CARELOOP_SERIAL_LINE_MAX 1024
typedef struct {
  char line[CARELOOP_SERIAL_LINE_MAX + 1];
  size_t length;
  bool rejected;
} careloop_serial_line_t;
typedef enum { CARELOOP_SERIAL_WAIT, CARELOOP_SERIAL_IDLE, CARELOOP_SERIAL_READY, CARELOOP_SERIAL_REJECTED } careloop_serial_result_t;

/* ESP-IDF's polling UART reports EOF when no byte is currently available.
   Clear that transient condition and retain the partial command until LF. */
static inline careloop_serial_result_t careloop_serial_poll(FILE *input, careloop_serial_line_t *state) {
  int ch=fgetc(input);
  if(ch==EOF){clearerr(input);return CARELOOP_SERIAL_IDLE;}
  if(ch=='\r')return CARELOOP_SERIAL_WAIT;
  if(ch=='\n'){
    bool ready=state->length!=0, rejected=state->rejected;
    state->line[state->length]=0;state->length=0;state->rejected=false;
    return rejected?CARELOOP_SERIAL_REJECTED:ready?CARELOOP_SERIAL_READY:CARELOOP_SERIAL_WAIT;
  }
  if(!ch||state->length==CARELOOP_SERIAL_LINE_MAX)state->rejected=true;
  else if(!state->rejected)state->line[state->length++]=(char)ch;
  return CARELOOP_SERIAL_WAIT;
}
