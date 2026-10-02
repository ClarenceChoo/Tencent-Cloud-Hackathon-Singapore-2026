#pragma once
#define GPIO_NUM_MAX 49
#define GPIO_MODE_OUTPUT 1
#define GPIO_MODE_INPUT 2
#define GPIO_PULLUP_ONLY 1
#define GPIO_PULLDOWN_ONLY 2
int gpio_set_level(int,int);
int gpio_get_level(int);
int gpio_set_direction(int,int);
int gpio_set_pull_mode(int,int);

#define GPIO_IS_VALID_GPIO(p) ((p)>=0 && (p)<49 && ((p)<=21 || (p)>=26))
#define GPIO_IS_VALID_OUTPUT_GPIO(p) GPIO_IS_VALID_GPIO(p)
