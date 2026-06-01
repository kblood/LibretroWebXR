 rem ==========================================================================
 rem  LWX Beam Dodger  -  a tiny one-screen Atari 2600 game
 rem  Part of LibretroWebXR. Authored by LibretroWebXR. License: CC0 (public domain).
 rem
 rem  Gameplay: you pilot a ship (player0) along the bottom of the screen.
 rem  Beams (player1) fall from the top. Move left/right to dodge them.
 rem  Every beam you survive adds to your score. One hit and the game resets.
 rem
 rem  Built with batari Basic (bB) using only its documented standard-kernel
 rem  statements (player sprites, playfield, joystick, score). bB generates the
 rem  TIA kernel; we only author the logic below.
 rem ==========================================================================

 rem ---- build/target directives ------------------------------------------
 rem Be explicit about the TV system so the standard kernel emits a clean,
 rem stable NTSC frame (262 scanlines) that every libretro stella build accepts.
 set tv ntsc
 set romsize 4k

 rem ---- variable aliases (bB gives us a..z; name the ones we use) ----------
 dim beamspeed = a
 dim playcolor = b
 dim startdelay = c

 rem ---- one-time setup ----------------------------------------------------
 player0x = 76 : player0y = 84
 player1x = 40 : player1y = 10
 beamspeed = 1
 score = 0
 scorecolor = $1E
 startdelay = 60

 rem A simple static playfield: a solid top rail and bottom rail so the play
 rem area is framed. 32-cell-wide rows; '.' = off, 'X' = on.
 playfield:
 XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
 ................................
 ................................
 ................................
 ................................
 ................................
 ................................
 ................................
 ................................
 ................................
 XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
end

main
 rem ---- background / colors (bB var COLUBK, COLUPF set every frame) -------
 rem A clearly-visible dark-blue night sky (NOT pure black, so the play area
 rem reads as "on" at a glance) with bright-grey rails for the frame.
 COLUBK = $82
 COLUPF = $0E

 rem ---- the player ship sprite (player0) ---------------------------------
 player0:
 %00011000
 %00011000
 %00111100
 %01111110
 %11111111
 %11111111
 %10100101
 %10100101
end
 COLUP0 = $4A

 rem ---- the falling beam sprite (player1) --------------------------------
 player1:
 %10000001
 %01000010
 %00100100
 %00011000
 %00011000
 %00100100
 %01000010
 %10000001
end
 COLUP1 = $46

 rem ---- joystick: move the ship left / right, clamped to the rails -------
 if joy0left  && player0x > 18  then player0x = player0x - 2
 if joy0right && player0x < 138 then player0x = player0x + 2

 rem ---- the beam falls; reset to a new column at the top when it lands ----
 player1y = player1y + beamspeed
 if player1y < 80 then skipreset
 player1y = 10
 player1x = (rand & 127) + 16
 score = score + 1
 rem speed up a little as the score climbs (capped so it stays dodgeable)
 if score > 9  && beamspeed < 2 then beamspeed = 2
 if score > 24 && beamspeed < 3 then beamspeed = 3
skipreset

 rem ---- collision: ship hit by beam -> flash and restart -----------------
 if !collision(player0,player1) then nohit
 COLUBK = $42
 score = 0
 beamspeed = 1
 player0x = 76
 player1y = 10
 player1x = 40
nohit

 drawscreen
 goto main
