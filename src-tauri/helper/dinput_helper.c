/*
 * Penguin Citizen — Wine DirectInput Axis Helper
 *
 * Enumerates joystick devices via DirectInput8. For each device, uses
 * EnumObjects to discover which DIJOYSTATE2 byte-offsets correspond to
 * which axis GUIDs (GUID_XAxis, GUID_RxAxis, etc.). This avoids the
 * device-specific ordering problem that a static index table would have.
 *
 * Reports axis movements to stdout:
 *   AXIS:{instance-GUID}:{sc-axis-name}:{normalized-value}
 *   READY  (once DirectInput is initialized)
 *
 * Axis names match Star Citizen's actionmaps.xml format:
 *   x, y, z, rotx, roty, rotz, slider1, slider2
 *
 * Exits when stdin is closed (parent closes its write end as a stop signal).
 *
 * Compile (from project root penguin-citizen-app/):
 *   x86_64-w64-mingw32-gcc -o src-tauri/resources/penguin-citizen-helper.exe \
 *     src-tauri/helper/dinput_helper.c -ldinput8 -ldxguid -lole32 -Wall -O2
 */

#define DIRECTINPUT_VERSION 0x0800
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dinput.h>
#include <stdio.h>
#include <string.h>

#define MAX_DEVICES      16
#define MAX_AXES         16
#define AXIS_THRESHOLD   3000   /* ~9% of 32767 */
#define POLL_MS          10
#define FORCE_EMIT_POLLS 10     /* emit all axis values every 100 ms regardless of delta */

/* Per-axis info discovered via EnumObjects */
typedef struct {
    DWORD offset;        /* byte offset into DIJOYSTATE2 */
    char  sc_name[16];   /* SC axis name: "x","y","rotx","roty",... */
} AxisInfo;

typedef struct {
    GUID                  instance_guid;
    char                  guid_str[48];
    wchar_t               product_name[MAX_PATH];
    char                  product_name_utf8[MAX_PATH];
    IDirectInputDevice8W *device;
    DIJOYSTATE2           prev_state;
    int                   has_baseline;
    int                   force_counter; /* counts polls until next forced emit */
    AxisInfo              axes[MAX_AXES];
    int                   naxes;
} DevInfo;

static IDirectInput8W *g_pDI    = NULL;
static DevInfo         g_devs[MAX_DEVICES];
static int             g_ndevs  = 0;

/* ------------------------------------------------------------------ */

static void guid_to_str(const GUID *g, char *out) {
    sprintf(out,
        "{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
        (unsigned long)g->Data1, g->Data2, g->Data3,
        g->Data4[0], g->Data4[1],
        g->Data4[2], g->Data4[3], g->Data4[4],
        g->Data4[5], g->Data4[6], g->Data4[7]);
}

/* Context passed to EnumObjects callback */
typedef struct {
    int   dev_idx;
    int   slider_count;  /* tracks how many GUID_Slider axes seen so far */
} EnumCtx;

/*
 * Callback: called once per DirectInput object (axis/button/hat).
 * We only handle DIDFT_AXIS objects. We map the axis GUID to a SC axis name
 * and record the DIJOYSTATE2 byte offset.
 */
static BOOL CALLBACK enum_objects_cb(LPCDIDEVICEOBJECTINSTANCEW doi, LPVOID pvRef) {
    EnumCtx  *ctx = (EnumCtx *)pvRef;
    DevInfo  *dev = &g_devs[ctx->dev_idx];
    const char *name = NULL;

    if (!(doi->dwType & DIDFT_AXIS)) return DIENUM_CONTINUE;
    if (dev->naxes >= MAX_AXES)      return DIENUM_STOP;

    if (IsEqualGUID(&doi->guidType, &GUID_XAxis))  name = "x";
    else if (IsEqualGUID(&doi->guidType, &GUID_YAxis))  name = "y";
    else if (IsEqualGUID(&doi->guidType, &GUID_ZAxis))  name = "z";
    else if (IsEqualGUID(&doi->guidType, &GUID_RxAxis)) name = "rotx";
    else if (IsEqualGUID(&doi->guidType, &GUID_RyAxis)) name = "roty";
    else if (IsEqualGUID(&doi->guidType, &GUID_RzAxis)) name = "rotz";
    else if (IsEqualGUID(&doi->guidType, &GUID_Slider)) {
        name = (ctx->slider_count == 0) ? "slider1" : "slider2";
        ctx->slider_count++;
    }

    if (!name) return DIENUM_CONTINUE;

    dev->axes[dev->naxes].offset = doi->dwOfs;
    strncpy(dev->axes[dev->naxes].sc_name, name, 15);
    dev->axes[dev->naxes].sc_name[15] = '\0';
    dev->naxes++;

    return DIENUM_CONTINUE;
}

/* ------------------------------------------------------------------ */

static BOOL CALLBACK enum_devices_cb(const DIDEVICEINSTANCEW *inst, VOID *ctx) {
    HRESULT  hr;
    EnumCtx  ectx;
    (void)ctx;
    if (g_ndevs >= MAX_DEVICES) return DIENUM_STOP;

    DevInfo *d = &g_devs[g_ndevs];
    memset(d, 0, sizeof(*d));
    d->instance_guid = inst->guidInstance;
    guid_to_str(&inst->guidInstance, d->guid_str);
    wcsncpy(d->product_name, inst->tszProductName, MAX_PATH - 1);
    WideCharToMultiByte(CP_UTF8, 0, inst->tszProductName, -1,
                        d->product_name_utf8, MAX_PATH, NULL, NULL);

    hr = IDirectInput8_CreateDevice(g_pDI, &inst->guidInstance, &d->device, NULL);
    if (FAILED(hr)) return DIENUM_CONTINUE;

    /* Must set data format before EnumObjects so offsets are DIJOYSTATE2 offsets */
    hr = IDirectInputDevice8_SetDataFormat(d->device, &c_dfDIJoystick2);
    if (FAILED(hr)) {
        IDirectInputDevice8_Release(d->device); d->device = NULL;
        return DIENUM_CONTINUE;
    }

    /* Discover real axis↔offset mapping for this device */
    ectx.dev_idx = g_ndevs;
    ectx.slider_count = 0;
    IDirectInputDevice8_EnumObjects(d->device, enum_objects_cb, &ectx, DIDFT_AXIS);

    /* Prefer DISCL_BACKGROUND + NULL HWND (no window needed) */
    hr = IDirectInputDevice8_SetCooperativeLevel(
            d->device, NULL, DISCL_BACKGROUND | DISCL_NONEXCLUSIVE);
    if (FAILED(hr)) {
        HWND hwnd = CreateWindowExW(0, L"STATIC", L"", WS_POPUP,
                                     0, 0, 1, 1, NULL, NULL, NULL, NULL);
        hr = IDirectInputDevice8_SetCooperativeLevel(
                d->device, hwnd, DISCL_BACKGROUND | DISCL_NONEXCLUSIVE);
        if (FAILED(hr)) {
            IDirectInputDevice8_Release(d->device); d->device = NULL;
            return DIENUM_CONTINUE;
        }
    }

    IDirectInputDevice8_Acquire(d->device);
    printf("DEVICE:%s:%s\n", d->guid_str, d->product_name_utf8);
    fflush(stdout);
    g_ndevs++;
    return DIENUM_CONTINUE;
}

/* ------------------------------------------------------------------ */

int main(void) {
    int i, a;
    CoInitialize(NULL);

    if (FAILED(DirectInput8Create(GetModuleHandleW(NULL), DIRECTINPUT_VERSION,
                                   &IID_IDirectInput8W, (VOID **)&g_pDI, NULL))) {
        fprintf(stderr, "ERROR: DirectInput8Create failed\n");
        CoUninitialize();
        return 1;
    }

    IDirectInput8_EnumDevices(g_pDI, DI8DEVCLASS_GAMECTRL,
                               enum_devices_cb, NULL, DIEDFL_ATTACHEDONLY);

    printf("READY\n");
    fflush(stdout);

    while (!feof(stdin)) {
        for (i = 0; i < g_ndevs; i++) {
            DevInfo *d = &g_devs[i];
            if (!d->device || d->naxes == 0) continue;

            IDirectInputDevice8_Poll(d->device);

            DIJOYSTATE2 state;
            if (FAILED(IDirectInputDevice8_GetDeviceState(
                    d->device, sizeof(state), &state))) {
                IDirectInputDevice8_Acquire(d->device);
                continue;
            }

            if (!d->has_baseline) {
                d->prev_state   = state;
                d->has_baseline = 1;
                d->force_counter = 0;
                /* Emit initial axis values so the Rust correlator has a starting
                 * point even before the user moves anything. */
                for (a = 0; a < d->naxes; a++) {
                    LONG curr = *(LONG *)((char *)&state + d->axes[a].offset);
                    double norm = (double)curr / 32767.0;
                    if (norm < -1.0) norm = -1.0;
                    if (norm >  1.0) norm =  1.0;
                    printf("AXIS:%s:%s:%.4f\n",
                           d->guid_str, d->axes[a].sc_name, norm);
                }
                fflush(stdout);
                continue;
            }

            d->force_counter++;
            int force_emit = (d->force_counter >= FORCE_EMIT_POLLS);
            if (force_emit) d->force_counter = 0;

            for (a = 0; a < d->naxes; a++) {
                /* Read value at the exact DIJOYSTATE2 byte offset for this axis */
                LONG curr = *(LONG *)((char *)&state         + d->axes[a].offset);
                LONG prev = *(LONG *)((char *)&d->prev_state + d->axes[a].offset);
                LONG delta = curr - prev;
                if (delta < 0) delta = -delta;

                if (delta > AXIS_THRESHOLD || force_emit) {
                    double norm = (double)curr / 32767.0;
                    if (norm < -1.0) norm = -1.0;
                    if (norm >  1.0) norm =  1.0;
                    printf("AXIS:%s:%s:%.4f\n",
                           d->guid_str, d->axes[a].sc_name, norm);
                    fflush(stdout);
                    if (delta > AXIS_THRESHOLD) {
                        /* Reset baseline only on real movement */
                        d->prev_state = state;
                    }
                }
            }
        }
        Sleep(POLL_MS);
    }

    for (i = 0; i < g_ndevs; i++) {
        if (g_devs[i].device) {
            IDirectInputDevice8_Unacquire(g_devs[i].device);
            IDirectInputDevice8_Release(g_devs[i].device);
        }
    }
    if (g_pDI) IDirectInput8_Release(g_pDI);
    CoUninitialize();
    return 0;
}
