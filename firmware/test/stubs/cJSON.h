#pragma once
#include <stddef.h>
#include <string.h>
typedef struct cJSON {struct cJSON *child,*next;const char *string,*valuestring;double valuedouble;int type;} cJSON;
#define cJSON_String 1
#define cJSON_Number 2
#define cJSON_NULL 3
#define cJSON_Array 4
#define cJSON_Object 5
static inline cJSON *cJSON_GetObjectItem(const cJSON *o,const char *k){for(cJSON *p=o?o->child:NULL;p;p=p->next)if(p->string&&!strcmp(p->string,k))return p;return NULL;}
static inline int cJSON_IsString(const cJSON *o){return o&&o->type==cJSON_String;}
static inline int cJSON_IsNumber(const cJSON *o){return o&&o->type==cJSON_Number;}
static inline int cJSON_IsNull(const cJSON *o){return o&&o->type==cJSON_NULL;}
static inline int cJSON_IsArray(const cJSON *o){return o&&o->type==cJSON_Array;}
static inline int cJSON_IsObject(const cJSON *o){return o&&o->type==cJSON_Object;}
static inline int cJSON_GetArraySize(const cJSON *o){int n=0;for(cJSON *p=o?o->child:NULL;p;p=p->next)n++;return n;}
static inline cJSON *cJSON_GetArrayItem(const cJSON *o,int n){cJSON *p=o?o->child:NULL;while(p&&n-->0)p=p->next;return p;}
#define cJSON_ArrayForEach(p,o) for(p=(o)->child;p;p=p->next)
cJSON *cJSON_Parse(const char*); cJSON *cJSON_ParseWithLength(const char*,size_t);
char *cJSON_PrintUnformatted(const cJSON*);void cJSON_Delete(cJSON*);void cJSON_free(void*);
