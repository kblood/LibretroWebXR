#ifndef GUNCON2_RPC_H
#define GUNCON2_RPC_H

/* Arbitrary vendor RPC number, shared between the IOP driver module and the
 * EE-side client. Doubles as a nod to the real GunCon2 VID/PID (0x0b9a:0x016a). */
#define GUNCON2_RPC_NUMBER 0x0b9a016a

typedef struct
{
    unsigned int connected;
    unsigned short buttons; /* raw active-low report bits, straight off the wire */
    short x;
    short y;
} guncon2_state_t;

#endif
