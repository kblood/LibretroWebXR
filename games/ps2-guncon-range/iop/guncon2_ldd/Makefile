IOP_BIN = guncon2_ldd.irx
IOP_OBJS = guncon2_ldd.o imports.o

all: $(IOP_BIN)

clean:
	rm -rf obj $(IOP_BIN) $(IOP_BIN:.irx=.notiopmod.elf) $(IOP_BIN:.irx=.notiopmod.stripped.elf)

include $(PS2SDK)/samples/Makefile.pref
include $(PS2SDK)/samples/Makefile.iopglobal
