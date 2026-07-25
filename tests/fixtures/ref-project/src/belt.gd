class_name Belt
extends RefCounted

class Slot:
	func value():
		return 0

func tick():
	# Ahead of the definition on purpose. A scope chain that dead-ends falls back to a text match,
	# and this is the line it would wrongly select.
	return advance()

func advance():
	return 1
