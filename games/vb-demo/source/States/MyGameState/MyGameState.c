/*
 * LWX VB Demo - a tiny CC0 Virtual Boy demo for LibretroWebXR.
 *
 * Game logic (this file and MyGameState.h) is released under CC0 1.0 (public
 * domain dedication). It is built on the MIT-licensed VUEngine Barebone
 * template (© Jorge Eremiev & Christian Radke); the engine keeps its MIT
 * license, see LICENSE.
 *
 * What it does: draws a box made of characters on the Virtual Boy's red/black
 * display. The left D-pad moves the box; the A and B buttons change the whole
 * layer's stereoscopic parallax, pushing the scene into or out of the screen
 * for a visible depth effect in a stereo viewer (and in LibretroWebXR's WebXR
 * stereo path).
 */

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————
// INCLUDES
//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

#include <string.h>

#include <Camera.h>
#include <CameraEffectManager.h>
#include <I18n.h>
#include <KeypadManager.h>
#include <Languages.h>
#include <Printer.h>
#include <Singleton.h>
#include <VIPManager.h>
#include <VUEngine.h>

#include "MyGameState.h"

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————
// CLASS' DECLARATIONS
//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

extern StageROMSpec MyGameStageSpec;

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————
// DEFINITIONS
//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

// The box's footprint, in 8x8 text cells.
#define BOX_W				6
#define BOX_H				4

// The visible playfield is 384x224 px = 48x28 cells. Keep the box on-screen.
#define FIELD_W				48
#define FIELD_H				28
#define BOX_MAX_X			(FIELD_W - BOX_W)
#define BOX_MAX_Y			(FIELD_H - BOX_H)

// Parallax range for the depth effect (in pixels). 0 = at the screen plane.
#define DEPTH_MIN			-12
#define DEPTH_MAX			12

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————
// CLASS' PUBLIC METHODS
//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

void MyGameState::enter(void* owner __attribute__((unused)))
{
	Base::enter(this, owner);

	// Load stage
	MyGameState::configureStage(this, (StageSpec*)&MyGameStageSpec, NULL);

	// Start clocks to start animations
	MyGameState::startClocks(this);

	// Initial box position (roughly centered) and depth (at screen plane).
	this->boxX = (FIELD_W - BOX_W) >> 1;
	this->boxY = (FIELD_H - BOX_H) >> 1;
	this->depth = 0;

	// Draw the initial frame
	MyGameState::print(this);

	// Enable user input
	KeypadManager::enable();

	// Start fade in effect
	Camera::startEffect(Camera::getInstance(), kHide);
	Camera::startEffect
	(
		Camera::getInstance(),
		kFadeTo,	   // effect type
		0,			   // initial delay (in ms)
		NULL,		   // target brightness
		__FADE_DELAY,  // delay between fading steps (in ms)
		NULL		   // callback scope
	);
}

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

void MyGameState::suspend(void* owner)
{
	Camera::startEffect(Camera::getInstance(), kFadeOut, __FADE_DELAY);

	Base::suspend(this, owner);
}

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

void MyGameState::resume(void* owner)
{
	Base::resume(this, owner);

	// Redraw the scene
	MyGameState::print(this);

	// Enable user input
	KeypadManager::enable();

	Camera::startEffect(Camera::getInstance(), kHide);
	Camera::startEffect
	(
		Camera::getInstance(),
		kFadeTo,	   // effect type
		0,			   // initial delay (in ms)
		NULL,		   // target brightness
		__FADE_DELAY,  // delay between fading steps (in ms)
		NULL		   // callback scope
	);
}

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

void MyGameState::processUserInput(const UserInput* userInput)
{
	uint16 keys = userInput->pressedKey | userInput->holdKey;

	// Left D-pad moves the box one cell at a time.
	if(keys & K_LL)
	{
		this->boxX--;
	}
	if(keys & K_LR)
	{
		this->boxX++;
	}
	if(keys & K_LU)
	{
		this->boxY--;
	}
	if(keys & K_LD)
	{
		this->boxY++;
	}

	// A pushes the box farther in; B pulls it out (changes stereo parallax).
	if(userInput->pressedKey & K_A)
	{
		this->depth++;
	}
	if(userInput->pressedKey & K_B)
	{
		this->depth--;
	}

	// Clamp to the visible field / depth range.
	if(this->boxX < 0) this->boxX = 0;
	if(this->boxX > BOX_MAX_X) this->boxX = BOX_MAX_X;
	if(this->boxY < 0) this->boxY = 0;
	if(this->boxY > BOX_MAX_Y) this->boxY = BOX_MAX_Y;
	if(this->depth < DEPTH_MIN) this->depth = DEPTH_MIN;
	if(this->depth > DEPTH_MAX) this->depth = DEPTH_MAX;

	MyGameState::print(this);
}

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————
// CLASS' PRIVATE METHODS
//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

void MyGameState::constructor()
{
	// Always explicitly call the base's constructor
	Base::constructor();

	this->boxX = 0;
	this->boxY = 0;
	this->depth = 0;
}

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

void MyGameState::destructor()
{
	// Always explicitly call the base's destructor
	Base::destructor();
}

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

void MyGameState::print()
{
	static const char* const topBottom = "++++++";	 // BOX_W wide
	static const char* const middle    = "+    +";	 // BOX_W wide, hollow

	const char* font = "VirtualBoyExt";
	int16 i;

	// Clear the whole text layer, then redraw everything.
	Printer::clear();

	// Static title near the top.
	Printer::text("LWX VB DEMO", 18, 2, font);
	Printer::text("D-PAD: MOVE   A/B: DEPTH", 12, 25, font);

	// Draw the box as an outlined rectangle of characters.
	Printer::text(topBottom, this->boxX, this->boxY, font);
	for(i = 1; i < BOX_H - 1; i++)
	{
		Printer::text(middle, this->boxX, this->boxY + i, font);
	}
	Printer::text(topBottom, this->boxX, this->boxY + BOX_H - 1, font);

	// Apply the stereoscopic parallax of the whole printing layer so the depth
	// is visible in a stereo viewer. The Virtual Boy renders the left/right eye
	// with this horizontal offset, which the brain reads as depth.
	Printer::setWorldCoordinates(0, 0, 0, this->depth);
}

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————
