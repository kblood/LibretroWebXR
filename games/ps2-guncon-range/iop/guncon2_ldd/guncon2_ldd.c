/*
 * guncon2_ldd - a real PS2 USB LDD (low-level device driver) module for the
 * Namco GunCon2 (VID 0x0b9a, PID 0x016a), written against the standard
 * ps2sdk usbd.h API. This exercises the actual IOP-side USB driver protocol
 * (sceUsbdRegisterLdd, descriptor scanning, pipe open, interrupt-transfer
 * polling) rather than any emulator-specific shortcut, so that running it
 * against Play!'s emulated CGunCon2UsbDevice proves a real driver can bind
 * to and poll the device the same way it would on real hardware or any
 * other libretro/PCSX2-style GunCon2 emulation.
 *
 * State is exposed to the EE side via a small SIF RPC service (see
 * guncon2_rpc.h) rather than direct exports, since the LDD only needs to be
 * discovered by name ("guncon2") by the USB subsystem, not linked against.
 */
#include <sysclib.h>
#include <thbase.h>
#include <sifcmd.h>
#include <usbd.h>

#include "../../guncon2_rpc.h"

/* ---- USB LDD state ---------------------------------------------------- */

static int guncon2_pipe_id = -1;
static volatile int guncon2_connected = 0;
static volatile unsigned short guncon2_buttons = 0xffff; /* active-low: all released */
static volatile short guncon2_x = 0;
static volatile short guncon2_y = 0;

/* GunCon2Out report is 6 bytes; pad slightly so the DMA-adjacent transfer
 * buffer never straddles a cacheline in a way that could confuse the sim. */
static unsigned char guncon2_xfer_buf[8];

static void guncon2_transfer_done(int result, int count, void *arg);

static void guncon2_kick_transfer(void)
{
    sceUsbdTransferPipe(guncon2_pipe_id, guncon2_xfer_buf, 6, NULL, guncon2_transfer_done, NULL);
}

static void guncon2_transfer_done(int result, int count, void *arg)
{
    if(result == USB_RC_OK && count >= 6)
    {
        unsigned short buttons = guncon2_xfer_buf[0] | (guncon2_xfer_buf[1] << 8);
        short x = (short)(guncon2_xfer_buf[2] | (guncon2_xfer_buf[3] << 8));
        short y = (short)(guncon2_xfer_buf[4] | (guncon2_xfer_buf[5] << 8));
        guncon2_buttons = buttons;
        guncon2_x = x;
        guncon2_y = y;
    }
    /* Re-issue immediately; the emulated device paces completion to ~60Hz
     * on its own (PS2::IOP_CLOCK_OVER_FREQ / 60 between CountTicks flips). */
    guncon2_kick_transfer();
}

static int guncon2_probe(int devId)
{
    (void)devId;
    return 0;
}

static int guncon2_connect(int devId)
{
    void *devDesc, *cfgDesc, *ifDesc, *epDesc;

    /* Order matters: the emulated device reuses one scratch descriptor
     * buffer per scan call, with a one-shot guard on the ENDPOINT case, so
     * scan DEVICE/CONFIGURATION/INTERFACE first and ENDPOINT exactly once,
     * last. */
    devDesc = sceUsbdScanStaticDescriptor(devId, NULL, USB_DT_DEVICE);
    cfgDesc = sceUsbdScanStaticDescriptor(devId, NULL, USB_DT_CONFIG);
    ifDesc = sceUsbdScanStaticDescriptor(devId, NULL, USB_DT_INTERFACE);
    epDesc = sceUsbdScanStaticDescriptor(devId, NULL, USB_DT_ENDPOINT);
    (void)devDesc;
    (void)cfgDesc;
    (void)ifDesc;

    if(epDesc == NULL)
        return -1;

    guncon2_pipe_id = sceUsbdOpenPipe(devId, (UsbEndpointDescriptor *)epDesc);
    if(guncon2_pipe_id < 0)
        return -1;

    guncon2_connected = 1;
    guncon2_kick_transfer();
    return 0;
}

static int guncon2_disconnect(int devId)
{
    (void)devId;
    guncon2_connected = 0;
    guncon2_pipe_id = -1;
    return 0;
}

static sceUsbdLddOps guncon2_ldd_ops = {
    .name = "guncon2",
    .probe = guncon2_probe,
    .connect = guncon2_connect,
    .disconnect = guncon2_disconnect,
};

/* ---- SIF RPC server ----------------------------------------------------
 * _start() must return promptly, so the RPC loop runs on its own thread. */

static SifRpcServerData_t guncon2_rpc_server;
static SifRpcDataQueue_t guncon2_rpc_queue;
static unsigned char guncon2_rpc_buf[64];

static void *guncon2_rpc_get_state(int fno, void *buffer, int length)
{
    guncon2_state_t *out = (guncon2_state_t *)buffer;
    (void)fno;
    (void)length;
    out->connected = guncon2_connected;
    out->buttons = guncon2_buttons;
    out->x = guncon2_x;
    out->y = guncon2_y;
    return buffer;
}

static void guncon2_rpc_thread(void *arg)
{
    (void)arg;
    sceSifSetRpcQueue(&guncon2_rpc_queue, GetThreadId());
    sceSifRegisterRpc(&guncon2_rpc_server, GUNCON2_RPC_NUMBER, guncon2_rpc_get_state,
                       guncon2_rpc_buf, NULL, NULL, &guncon2_rpc_queue);
    sceSifRpcLoop(&guncon2_rpc_queue);
}

int _start(int argc, char *argv[])
{
    iop_thread_t thread_param;
    int thid;

    (void)argc;
    (void)argv;

    sceUsbdRegisterLdd(&guncon2_ldd_ops);

    memset(&thread_param, 0, sizeof(thread_param));
    thread_param.attr = TH_C;
    thread_param.thread = guncon2_rpc_thread;
    thread_param.priority = 40;
    thread_param.stacksize = 0x800;

    thid = CreateThread(&thread_param);
    if(thid >= 0)
        StartThread(thid, NULL);

    return 0;
}
