//%attributes = {"invisible":true,"preemptive":"capable"}
/* block comment
   spanning lines */
#DECLARE($name : Text; $count : Integer) -> $result : Object
var $i; $j : Integer
var $o : cs.MyClass
var $f : 4D.File
var $col : Collection:=New collection(1; 2; 3)
var <>shared : Text

$result:=New object("name"; $name; "n"; $count)
$result.list:=[1; 2; "three"; !2024-01-01!; ?12:30:00?]
$x:=Current date+5
$y:=Uppercase:C13("abc")
$z:=Read Mode:K24:5
$a:=($i>3) ? "big" : "small"
$b:=$col[0]+$col.length
$arr{1}:=2
$p:=->$i
$p->:=5
ALL RECORDS([People])
[People]Last Name:="Smith"
QUERY([People]; [People]Age>=18 & [People]Name="J@")
ARRAY TEXT($names; 0)
$s:="He said \"hi\"\n"
$v:=Form.items.query("name = :1"; $name).first()
$obj:={name: "x"; items: [1; 2]; nested: {a: 1}}
$m:=$i%2+$j\3
$bit:=$i ?+ 3
$ok:=Not($i=0) | ($j#2)
$0:=${1}

If (Is nil($o))
	return
Else
	$o.run($i)
End if

If (Not($i=0))
	$i-=1
End if

For ($i; 1; 10)
	If ($i=5)
		continue
	End if
	break
End for

For each ($e; $col) While ($e#"x")
	LOG EVENT($e)
End for each

While ($i<10)
	$i+=1
End while

Repeat
	$i-=1
Until ($i<=0)

Case of
	: ($i=1)
		$a:="one"
	: ($i=2)
		$a:="two"
	Else
		$a:="many"
End case

Use ($o)
	$o.x:=1
End use

Try
	Throw({code: 1; message: "x"})
Catch
	ALERT(Last errors.first().message)
End try

Begin SQL
	SELECT name FROM people WHERE age > 3 INTO :$names;
End SQL

Formula(ALERT("x")).call()
