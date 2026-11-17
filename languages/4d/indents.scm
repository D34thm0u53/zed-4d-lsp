(arguments ")" @end) @indent
(parameters ")" @end) @indent
(object_literal "}" @end) @indent
(collection_literal "]" @end) @indent

(if_statement (kw_end_if) @end) @indent
(while_statement (kw_end_while) @end) @indent
(for_statement (kw_end_for) @end) @indent
(for_each_statement (kw_end_for_each) @end) @indent
(case_statement (kw_end_case) @end) @indent
(use_statement (kw_end_use) @end) @indent
(try_statement (kw_end_try) @end) @indent
(repeat_statement (kw_until) @end) @indent
(sql_block (kw_end_sql) @end) @indent

(else_clause (kw_else) @outdent)
(if_statement (kw_else) @outdent)
(try_statement (kw_catch) @outdent)
(case_clause ":" @outdent)
