#include <atspi/atspi.h>
#include <gtk/gtk.h>
#include <xdo.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

static void redacted(const char *text) {
  int in_url = 0;
  for (const char *p = text ? text : ""; *p; p++) {
    if (!strncmp(p, "https://", 8) || !strncmp(p, "http://", 7)) in_url = 1;
    if (in_url && (*p == '?' || *p == '#')) {
      fputs("?<redacted>", stdout);
      while (p[1] && !isspace((unsigned char)p[1])) p++;
    } else {
      putchar(*p);
    }
    if (isspace((unsigned char)*p)) in_url = 0;
  }
}

static AtspiAccessible *found;
static const char *wanted_role, *wanted_name;
static void tree(AtspiAccessible *node, int depth) {
  if (!node || depth > 24) return;
  GError *error = NULL;
  char *name = atspi_accessible_get_name(node, &error);
  if (error) { g_clear_error(&error); return; }
  char *role = atspi_accessible_get_role_name(node, &error);
  printf("%*s[%s] ", depth * 2, "", role ? role : "?");
  redacted(name); putchar('\n');
  if (wanted_role && role && name && !strcmp(wanted_role, role) && !strcmp(wanted_name, name)) {
    if (found) { fprintf(stderr, "Ambiguous accessibility target\n"); exit(1); }
    found = g_object_ref(node);
  }
  AtspiText *text = atspi_accessible_get_text_iface(node);
  if (text) {
    char *content = atspi_text_get_text(text, 0, -1, &error);
    if (content) { printf("%*sTEXT ", depth * 2 + 2, ""); redacted(content); putchar('\n'); }
    g_free(content); g_object_unref(text); g_clear_error(&error);
  }
  AtspiStateSet *states = atspi_accessible_get_state_set(node);
  if (atspi_state_set_contains(states, ATSPI_STATE_SELECTED)) printf("%*sSELECTED\n", depth * 2+2, "");
  if (role && !strcmp(role, "push button"))
    printf("%*s%s\n", depth * 2+2, "", atspi_state_set_contains(states, ATSPI_STATE_ENABLED) ? "ENABLED" : "DISABLED");
  g_object_unref(states);
  g_free(name); g_free(role); g_clear_error(&error);
  int children = atspi_accessible_get_child_count(node, &error);
  g_clear_error(&error);
  for (int i = 0; i < children && i < 1000; i++) {
    AtspiAccessible *child = atspi_accessible_get_child_at_index(node, i, &error);
    g_clear_error(&error);
    tree(child, depth + 1);
    if (child) g_object_unref(child);
  }
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (!strcmp(argv[1], "tree") || !strcmp(argv[1], "focus") || !strcmp(argv[1], "action")) {
    if (atspi_init()) return 1;
    if (argc == 4) { wanted_role = argv[2]; wanted_name = argv[3]; }
    tree(atspi_get_desktop(0), 0);
    if (wanted_role) {
      if (!found) { fprintf(stderr, "Accessibility target absent\n"); return 1; }
      GError *error = NULL;
      gboolean ok = FALSE;
      if (!strcmp(argv[1], "focus")) {
        AtspiComponent *component = atspi_accessible_get_component_iface(found);
        if (component) { ok = atspi_component_grab_focus(component, &error); g_object_unref(component); }
      } else {
        AtspiAction *action = atspi_accessible_get_action_iface(found);
        if (action) { ok = atspi_action_do_action(action, 0, &error); g_object_unref(action); }
      }
      if (!ok || error) { fprintf(stderr, "Accessibility action failed: %s\n", error ? error->message : "unsupported"); return 1; }
      g_object_unref(found);
    }
    atspi_exit();
    return 0;
  }
  gtk_init(&argc, &argv);
  if (!strcmp(argv[1], "shot") && argc == 3) {
    GdkWindow *root = gdk_get_default_root_window();
    GdkPixbuf *image = gdk_pixbuf_get_from_window(root, 0, 0, gdk_window_get_width(root), gdk_window_get_height(root));
    GError *error = NULL;
    if (!image || !gdk_pixbuf_save(image, argv[2], "png", &error, NULL)) return 1;
    GHashTable *colours = g_hash_table_new(g_direct_hash, g_direct_equal);
    guchar *pixels = gdk_pixbuf_get_pixels(image);
    int stride = gdk_pixbuf_get_rowstride(image), channels = gdk_pixbuf_get_n_channels(image);
    for (int y = 0; y < gdk_pixbuf_get_height(image); y += 2)
      for (int x = 0; x < gdk_pixbuf_get_width(image); x += 2) {
        guchar *p = pixels + y * stride + x * channels;
        guint rgb = (((guint)p[0] << 16) | ((guint)p[1] << 8) | p[2]) + 1;
        g_hash_table_add(colours, GUINT_TO_POINTER(rgb));
      }
    printf("%u\n", g_hash_table_size(colours));
    g_hash_table_unref(colours);
    g_object_unref(image);
    return 0;
  }
  xdo_t *x = xdo_new(NULL);
  if (!x) return 1;
  if ((!strcmp(argv[1], "key") || !strcmp(argv[1], "type")) && argc == 3) {
    int result = !strcmp(argv[1], "key")
      ? xdo_send_keysequence_window(x, CURRENTWINDOW, argv[2], 12000)
      : xdo_enter_text_window(x, CURRENTWINDOW, argv[2], 12000);
    XSync(x->xdpy, False); xdo_free(x); return result;
  }
  xdo_free(x);
  return 2;
}
