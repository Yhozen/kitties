/*
 * kitty-grab: the display as a stream of JPEG pictures, each after a line "FRAME <bytes>", and
 * only when it changed; a line "PING" every two quiet seconds. It takes the same arguments and
 * writes the same stream as kitty-stream, much faster: it stays connected to the display and
 * reads it through shared memory (XShm), compares the raw pixels with the last picture (no
 * picture is made of a screen that did not change) and compresses with libjpeg.
 *
 *   kitty-grab [--stdin] [pictures per second, 1-30] [JPEG quality, 30-95]
 *
 * With --stdin it ends when its input closes: `docker exec -i` closes it when the reader goes.
 *
 *   gcc -O2 -o kitty-grab kitty-grab.c -lX11 -lXext -ljpeg
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <jpeglib.h>
#include <poll.h>
#include <signal.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <time.h>
#include <unistd.h>

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

static int arg_in(const char *s, int lo, int hi, int def) {
    char *end;
    long n = s ? strtol(s, &end, 10) : 0;
    return (s && *s && !*end && n >= lo && n <= hi) ? (int)n : def;
}

/* closed tells whether the input has been closed (a read of 0 bytes), without waiting. */
static int closed(void) {
    struct pollfd p = {.fd = 0, .events = POLLIN};
    char buf[256];
    while (poll(&p, 1, 0) > 0) {
        if (p.revents & (POLLHUP | POLLERR)) return 1;
        if (p.revents & POLLIN) {
            ssize_t n = read(0, buf, sizeof buf);
            if (n <= 0) return 1;
        }
    }
    return 0;
}

/* encode compresses the BGRX pixels of the display to a JPEG in memory. */
static unsigned char *encode(const unsigned char *px, int w, int h, int stride, int quality, unsigned long *size) {
    struct jpeg_compress_struct c;
    struct jpeg_error_mgr err;
    unsigned char *out = NULL;
    *size = 0;
    c.err = jpeg_std_error(&err);
    jpeg_create_compress(&c);
    jpeg_mem_dest(&c, &out, size);
    c.image_width = w;
    c.image_height = h;
    c.input_components = 3;
    c.in_color_space = JCS_RGB;
    jpeg_set_defaults(&c);
    jpeg_set_quality(&c, quality, TRUE);
    jpeg_start_compress(&c, TRUE);
    unsigned char *row = malloc((size_t)w * 3);
    while (c.next_scanline < c.image_height) {
        const unsigned char *s = px + (size_t)c.next_scanline * stride;
        for (int x = 0; x < w; x++) {
            row[x * 3] = s[x * 4 + 2];
            row[x * 3 + 1] = s[x * 4 + 1];
            row[x * 3 + 2] = s[x * 4];
        }
        JSAMPROW r = row;
        jpeg_write_scanlines(&c, &r, 1);
    }
    free(row);
    jpeg_finish_compress(&c);
    jpeg_destroy_compress(&c);
    return out;
}

int main(int argc, char **argv) {
    int watch_stdin = 0;
    if (argc > 1 && strcmp(argv[1], "--stdin") == 0) {
        watch_stdin = 1;
        argc--;
        argv++;
    }
    int fps = arg_in(argc > 1 ? argv[1] : NULL, 1, 30, 8);
    int quality = arg_in(argc > 2 ? argv[2] : NULL, 30, 95, 70);
    signal(SIGPIPE, SIG_DFL);

    Display *dpy = XOpenDisplay(NULL);
    if (!dpy) {
        fprintf(stderr, "kitty-grab: cannot open the display %s\n", getenv("DISPLAY") ? getenv("DISPLAY") : "(none)");
        return 1;
    }
    Window root = DefaultRootWindow(dpy);
    XWindowAttributes at;
    XGetWindowAttributes(dpy, root, &at);
    int w = at.width, h = at.height;

    /* Shared memory when the server has it; a plain XGetImage otherwise. */
    XShmSegmentInfo shm = {.shmid = -1};
    XImage *img = NULL;
    if (XShmQueryExtension(dpy)) {
        img = XShmCreateImage(dpy, at.visual, at.depth, ZPixmap, NULL, &shm, w, h);
        if (img) {
            shm.shmid = shmget(IPC_PRIVATE, (size_t)img->bytes_per_line * img->height, IPC_CREAT | 0600);
            shm.shmaddr = img->data = shm.shmid < 0 ? (char *)-1 : shmat(shm.shmid, NULL, 0);
            shm.readOnly = False;
            if (shm.shmid < 0 || shm.shmaddr == (char *)-1 || !XShmAttach(dpy, &shm)) {
                img->data = NULL;
                XDestroyImage(img);
                img = NULL;
            } else {
                XSync(dpy, False);
                shmctl(shm.shmid, IPC_RMID, NULL); /* gone when this process is */
            }
        }
    }

    unsigned char *last = NULL;
    size_t lastsize = 0;
    long period = 1000L / fps, next = now_ms(), quiet_since = now_ms();
    for (;;) {
        if (watch_stdin && closed()) break;
        XImage *shot = img;
        if (img) {
            if (!XShmGetImage(dpy, root, img, 0, 0, AllPlanes)) shot = NULL;
        } else {
            shot = XGetImage(dpy, root, 0, 0, w, h, AllPlanes, ZPixmap);
        }
        if (shot && shot->bits_per_pixel == 32) {
            size_t size = (size_t)shot->bytes_per_line * shot->height;
            if (!last || lastsize != size || memcmp(last, shot->data, size) != 0) {
                unsigned long jsize;
                unsigned char *jpg = encode((unsigned char *)shot->data, w, h, shot->bytes_per_line, quality, &jsize);
                if (printf("FRAME %lu\n", jsize) < 0 || fwrite(jpg, 1, jsize, stdout) != jsize || fflush(stdout) != 0) return 0;
                free(jpg);
                if (lastsize != size) {
                    free(last);
                    last = malloc(size);
                    lastsize = size;
                }
                memcpy(last, shot->data, size);
                quiet_since = now_ms();
            } else if (now_ms() - quiet_since >= 2000) {
                if (fputs("PING\n", stdout) < 0 || fflush(stdout) != 0) return 0;
                quiet_since = now_ms();
            }
        }
        if (shot && shot != img) XDestroyImage(shot);
        next += period;
        long wait = next - now_ms();
        if (wait > 0) {
            usleep((useconds_t)wait * 1000);
        } else {
            next = now_ms();
        }
    }
    if (img) {
        XShmDetach(dpy, &shm);
        XDestroyImage(img);
        shmdt(shm.shmaddr);
    }
    XCloseDisplay(dpy);
    return 0;
}
