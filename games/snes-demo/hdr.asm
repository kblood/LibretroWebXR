
.MEMORYMAP                      ; Begin describing the system architecture.
  SLOTSIZE $8000                ; The slot is $8000 bytes in size.
  DEFAULTSLOT 0                 ; There's only 1 slot in SNES.
  SLOT 0 $8000                  ; Defines Slot 0's starting address.
  SLOT 1 $0 $2000
  SLOT 2 $2000 $E000
  SLOT 3 $0 $10000
.ENDME          ; End MemoryMap definition

.ROMBANKSIZE $8000              ; Every ROM bank is 32 KBytes in size
.ROMBANKS 8                     ; 2 Mbits - 8 ROM Banks

.SNESHEADER
  ID "SNES"                     ; 1-4 letter string, just leave it as "SNES"

  NAME "LWX SNES DEMO        "  ; Program Title - max 21 bytes,
  ;    "123456789012345678901"  ; use spaces for unused bytes of the name.

  SLOWROM
  LOROM

  CARTRIDGETYPE $00             ; $00 = ROM only
  ROMSIZE $08                   ; $08 = 2 Mbits
  SRAMSIZE $00                  ; $00 = No Sram
  COUNTRY $01                   ; $01 = U.S.
  LICENSEECODE $00              ; Just use $00
  VERSION $00                   ; $00 = 1.00
.ENDSNES

.SNESNATIVEVECTOR               ; Define Native Mode interrupt vector table
  COP EmptyHandler
  BRK EmptyHandler
  ABORT EmptyHandler
  NMI VBlank
  IRQ EmptyHandler
.ENDNATIVEVECTOR

.SNESEMUVECTOR                  ; Define Emulation Mode interrupt vector table
  COP EmptyHandler
  ABORT EmptyHandler
  NMI EmptyHandler
  RESET tcc__start                   ; where execution starts
  IRQBRK EmptyHandler
.ENDEMUVECTOR
