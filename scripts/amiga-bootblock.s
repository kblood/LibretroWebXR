; lwx-amiga-demo — minimal Amiga boot-block intro.  CC0 / public domain.
; Part of LibretroWebXR's "author our own per-system test game" content.
;
; Assemble:  vasmm68k_mot -Fbin -o boot.bin scripts/amiga-bootblock.s
; The 68k bytes are then embedded + checksummed + packed into a 901120-byte
; DD .adf by scripts/make-amiga-demo.mjs (the boot-block checksum is computed
; there, so the dc.l 0 placeholder below is fine).
;
; On boot the Kickstart (here PUAE's built-in AROS) validates the "DOS"
; signature + checksum, then jumps to offset 12 with a6=ExecBase and
; a1=an open trackdisk IORequest. We ignore both and bang the OCS custom
; chips directly (fixed addresses $dff000+), so it needs no OS services and
; never returns — it just cycles the full-screen background colour forever,
; which is unmistakable proof a real 68000 program ran from the disk.

    dc.b    'D','O','S',0       ; 0:  disk type (OFS)
    dc.l    0                   ; 4:  boot-block checksum (packer fills this in)
    dc.l    880                 ; 8:  root block (880 = DD)

; --- code, entry point @ offset 12 -------------------------------------------
start:
    lea     $dff000,a0          ; a0 = custom chip base
    move.w  #$7fff,$09a(a0)     ; INTENA: clear all interrupt enables
    move.w  #$7fff,$096(a0)     ; DMACON: clear all DMA (screen = COLOR00 only)
    moveq   #0,d0               ; d0 = colour accumulator
.loop:
    move.w  d0,$180(a0)         ; COLOR00 ($dff180) = background colour
    move.l  #$0002ffff,d1       ; visible delay between colour steps
.delay:
    subq.l  #1,d1
    bne.s   .delay
    addq.w  #1,d0               ; next colour
    andi.w  #$0fff,d0           ; wrap to the 12-bit OCS colour space (0..4095)
    bra.s   .loop               ; forever
