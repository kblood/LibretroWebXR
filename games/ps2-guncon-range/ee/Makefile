EE_BIN = guncon-range.elf
EE_OBJS = main.o guncon2_ldd_irx.o

EE_LIBS = -lpacket -ldma -lgraph -ldraw -lc

all: $(EE_BIN)
	cp $(EE_BIN) $(EE_BIN:.elf=.unstripped.elf)
	$(EE_STRIP) --strip-all $(EE_BIN)

clean:
	rm -f $(EE_BIN) $(EE_OBJS) guncon2_ldd_irx.c

guncon2_ldd_irx.c: ../iop/guncon2_ldd/guncon2_ldd.irx
	bin2c $< $@ guncon2_ldd_irx

include $(PS2SDK)/samples/Makefile.pref
include $(PS2SDK)/samples/Makefile.eeglobal
