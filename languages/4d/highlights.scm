; ---- comments ----
(comment) @comment

; ---- literals ----
(string) @string
(string_content) @string
(escape_sequence) @string.escape
(number) @number
(date_literal) @number
(time_literal) @number
(boolean) @boolean
(null) @constant.builtin
(this) @variable.special
(super) @variable.special

; ---- variables ----
(local_variable) @variable
(parameter_reference) @variable.parameter
(interprocess_variable) @variable.special
((local_variable) @variable.parameter
  (#match? @variable.parameter "^\\$[0-9]+$"))
(table_name) @type
(table_reference field: (name) @property)

; ---- names ----
(name) @variable
(token_suffix) @comment

(pair key: (name) @property)
(member_expression property: (name) @property)

; calls: commands, project methods, functions, member calls
(call_expression function: (name) @function)
(call_expression function: (member_expression property: (name) @function.method))

; ---- types ----
(type) @type

; ---- declarations ----
(function_definition name: (name) @function)
(property_declaration name: (name) @property)
(var_item name: (local_variable) @variable)
(var_item name: (interprocess_variable) @variable.special)
(parameter name: (local_variable) @variable.parameter)
(alias_statement name: (name) @function)
(alias_statement target: (name) @variable)

; ---- keywords ----
[
  (kw_if) (kw_else) (kw_end_if)
  (kw_while) (kw_end_while)
  (kw_repeat) (kw_until)
  (kw_for) (kw_end_for)
  (kw_for_each) (kw_end_for_each)
  (kw_case_of) (kw_end_case)
  (kw_use) (kw_end_use)
  (kw_try) (kw_catch) (kw_end_try) (kw_throw)
  (kw_begin_sql) (kw_end_sql)
  (kw_return) (kw_break) (kw_continue)
  (kw_var) (kw_property) (kw_alias)
  (kw_function) (kw_class_constructor) (kw_extends) (kw_accessor) (kw_declare)
] @keyword

(sql_line) @embedded

; ---- operators & punctuation ----
[
  ":=" "+=" "-=" "*=" "/=" "%="
  "=" "#" "<" ">" "<=" ">="
  "+" "-" "*" "/" "\\" "%" "**"
  "&" "|" "&&" "||" "^|"
  "<<" ">>" "?+" "?-" "??"
  "?" "->" "!" "..."
] @operator

[ "(" ")" "[" "]" "{" "}" ] @punctuation.bracket
[ ";" "," ":" "." ] @punctuation.delimiter
