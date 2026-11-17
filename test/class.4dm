Class extends Entity

property name : Text
property a; b : Integer
property c

exposed Function get fullName() : Text
	return This.first+" "+This.last

Class constructor($first : Text; $last : Text)
	This.first:=$first
	This.last:=$last

local Function query age($event : Object) : Object
	var $r : Object:={}
	return $r

shared singleton Class constructor()
Function foo($a : Text; ... : Integer) -> $r : Integer
	$r:=Super.foo($a)

Function get()
	return 1
