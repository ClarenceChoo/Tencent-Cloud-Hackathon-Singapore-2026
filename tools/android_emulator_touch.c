/* Virtual touchscreen input for TalkBack tests; refuses non-emulator devices. */
#include <fcntl.h>
#include <linux/input.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/system_properties.h>
#include <unistd.h>

static int fd = -1, pressed = 0;
static void emit(int type, int code, int value) {
  struct input_event event = {0};
  event.type = type; event.code = code; event.value = value;
  if (write(fd, &event, sizeof(event)) != sizeof(event)) { perror("input event"); exit(1); }
}
static void lift(void) {
  if (fd >= 0 && pressed) {
    pressed = 0;
    emit(EV_ABS, ABS_MT_PRESSURE, 0);
    emit(EV_ABS, ABS_MT_TRACKING_ID, -1);
    emit(EV_SYN, SYN_REPORT, 0);
  }
}
static void position(int x, int y) {
  emit(EV_ABS, ABS_MT_POSITION_X, x * 32767 / 1079);
  emit(EV_ABS, ABS_MT_POSITION_Y, y * 32767 / 2399);
}
static void down(int x, int y, int id) {
  emit(EV_ABS, ABS_MT_SLOT, 0);
  emit(EV_ABS, ABS_MT_TRACKING_ID, id);
  emit(EV_ABS, ABS_MT_TOOL_TYPE, MT_TOOL_FINGER);
  position(x, y);
  emit(EV_ABS, ABS_MT_PRESSURE, 512);
  emit(EV_ABS, ABS_MT_TOUCH_MAJOR, 30);
  emit(EV_ABS, ABS_MT_TOUCH_MINOR, 30);
  pressed = 1;
  emit(EV_SYN, SYN_REPORT, 0);
}
static void tap(int x, int y, int id) {
  down(x, y, id); usleep(60000); lift();
}
int main(int argc, char **argv) {
  char prop[PROP_VALUE_MAX] = {0}, name[128] = {0};
  if (argc != 2 || (strcmp(argv[1], "next") && strcmp(argv[1], "previous") && strcmp(argv[1], "logo") && strcmp(argv[1], "double"))) return 2;
  __system_property_get("ro.kernel.qemu", prop);
  if (strcmp(prop, "1")) { fputs("Disposable emulator required\n", stderr); return 3; }
  fd = open("/dev/input/event1", O_RDWR | O_CLOEXEC);
  if (fd < 0) { perror("virtual touchscreen"); return 4; }
  if (ioctl(fd, EVIOCGNAME(sizeof(name)), name) < 0 || strcmp(name, "virtio_input_multi_touch_1")) return 5;
  struct input_absinfo x, y;
  if (ioctl(fd, EVIOCGABS(ABS_MT_POSITION_X), &x) || ioctl(fd, EVIOCGABS(ABS_MT_POSITION_Y), &y) ||
      x.minimum != 0 || y.minimum != 0 || x.maximum != 32767 || y.maximum != 32767) return 6;
  atexit(lift);
  if (!strcmp(argv[1], "next") || !strcmp(argv[1], "previous")) {
    int start = !strcmp(argv[1], "next") ? 280 : 780;
    int delta = !strcmp(argv[1], "next") ? 500 : -500;
    down(start, 1000, 41);
    for (int i = 1; i <= 16; i++) { usleep(12500); position(start + delta*i/16, 1000); emit(EV_SYN, SYN_REPORT, 0); }
    lift();
  } else if (!strcmp(argv[1], "logo")) tap(170, 250, 42);
  else { tap(540, 1100, 43); usleep(90000); tap(540, 1100, 44); }
  close(fd); fd = -1;
  return 0;
}
