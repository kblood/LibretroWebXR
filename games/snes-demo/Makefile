ifeq ($(strip $(PVSNESLIB_HOME)),)
$(error "Please create an environment variable PVSNESLIB_HOME by following this guide: https://github.com/alekmaul/pvsneslib/wiki/Installation")
endif

include ${PVSNESLIB_HOME}/devkitsnes/snes_rules

.PHONY: bitmaps all

#---------------------------------------------------------------------------------
# ROMNAME is used in snes_rules file
export ROMNAME := snesdemo

all: bitmaps $(ROMNAME).sfc

clean: cleanBuildRes cleanRom cleanGfx

#---------------------------------------------------------------------------------
# Convert the console font (used as the background tile set + text).
pvsneslibfont.pic: pvsneslibfont.bmp
	@echo convert font ... $(notdir $@)
	$(GFXCONV) -s 8 -o 16 -u 16 -p -e 0 -t bmp -i $<

# Convert the 16x16 player sprite.
sprites.pic: sprites.bmp
	@echo convert sprite ... $(notdir $@)
	$(GFXCONV) -s 16 -o 16 -u 16 -t bmp -i $<

bitmaps : pvsneslibfont.pic sprites.pic
