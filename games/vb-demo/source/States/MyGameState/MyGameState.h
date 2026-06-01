/*
 * LWX VB Demo - a tiny CC0 Virtual Boy demo for LibretroWebXR.
 *
 * Game logic (this file and MyGameState.c) is released under CC0 1.0 (public
 * domain dedication). It is built on the MIT-licensed VUEngine Barebone
 * template (© Jorge Eremiev & Christian Radke); the engine keeps its MIT
 * license, see LICENSE.
 */

#ifndef MY_GAME_STATE_H_
#define MY_GAME_STATE_H_

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————
// INCLUDES
//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

#include <AlignmentCheckBaseGameState.h>
#include <GameState.h>
#include <KeypadManager.h>

//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————
// CLASS' DECLARATION
//——————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————————

///
/// Class MyGameState
///
/// Inherits from GameState
///
/// A minimal one-scene demo: move a box with the left D-pad, push it into /
/// pull it out of the screen with A / B (stereoscopic parallax depth).
singleton class MyGameState : AlignmentCheckBaseGameState
{
	/// @protectedsection

	/// Box position, in text cells (column / row).
	int16 boxX;
	int16 boxY;

	/// Stereo parallax of the whole printing layer (depth). Negative = closer.
	int8 depth;

	/// @publicsection

	/// Method to get the singleton instance
	/// @return MyGameState singleton
	static MyGameState getInstance();

	/// Prepares the object to enter this state.
	/// @param owner: Object that is entering in this state
	override void enter(void* owner);

	/// Prepares the object to become inactive in this state.
	/// @param owner: Object that is in this state
	override void suspend(void* owner);

	/// Prepares the object to become active in this state.
	/// @param owner: Object that is in this state
	override void resume(void* owner);

	/// Process the user's input.
	/// @param userInput: Pressed/held keys this cycle
	override void processUserInput(const UserInput* userInput);
}

#endif
