/**
 * Tree-sitter grammar for the 4D language (.4dm).
 *
 * Design notes
 *  - 4D is case-insensitive and line oriented, so newlines are significant
 *    (`_nl`) and keywords are case-insensitive regex tokens.
 *  - Command / method names may contain spaces ("Current date", "ARRAY TEXT").
 *    Words are therefore lexed individually and joined into a `name` node.
 *  - Tokenized source uses suffixes such as `Uppercase:C13` or `Read mode:K24:5`.
 *  - The grammar is deliberately tolerant: highlighting must keep working while
 *    the user is half way through typing a statement.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const WORD = /[A-Za-z_À-￿][A-Za-z0-9_À-￿]*/;

/** Case-insensitive regex for a (possibly multi word) keyword. */
const ci = (s) =>
  new RegExp(
    s
      .split("")
      .map((c) =>
        c === " "
          ? "[ \\t]+"
          : /[a-z]/i.test(c)
            ? `[${c.toLowerCase()}${c.toUpperCase()}]`
            : c,
      )
      .join(""),
  );

const KEYWORDS = {
  if: "if",
  else: "else",
  end_if: "end if",
  while: "while",
  end_while: "end while",
  repeat: "repeat",
  until: "until",
  for: "for",
  for_each: "for each",
  end_for: "end for",
  end_for_each: "end for each",
  case_of: "case of",
  end_case: "end case",
  use: "use",
  end_use: "end use",
  try: "try",
  catch: "catch",
  end_try: "end try",
  throw: "throw",
  begin_sql: "begin sql",
  end_sql: "end sql",
  var: "var",
  property: "property",
  return: "return",
  break: "break",
  continue: "continue",
  this: "this",
  super: "super",
  true: "true",
  false: "false",
  null: "null",
  alias: "alias",
  extends: "class extends",
};

const MODIFIER = choice(ci("exposed"), ci("local"), ci("shared"), ci("singleton"));

const PREC = {
  assign: 1,
  ternary: 2,
  or: 3,
  and: 4,
  compare: 5,
  bitshift: 6,
  add: 7,
  mul: 8,
  power: 9,
  unary: 10,
  postfix: 11,
  call: 12,
};

const sep1 = (rule, sep) => seq(rule, repeat(seq(sep, rule)));

module.exports = grammar({
  name: "fourd",

  extras: ($) => [/[ \t\r\f]+/, /\\\r?\n/, $.comment],

  rules: {
    source_file: ($) => repeat($._line),

    _line: ($) => choice($._nl, $._statement),

    _nl: () => token(/(\r?\n)+/),

    // ------------------------------------------------------------------
    // Comments
    // ------------------------------------------------------------------
    comment: () =>
      token(
        choice(
          seq("//", /[^\r\n]*/),
          seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/"),
        ),
      ),

    // ------------------------------------------------------------------
    // Keyword tokens (case-insensitive)
    // ------------------------------------------------------------------
    ...Object.fromEntries(
      Object.entries(KEYWORDS).map(([k, v]) => [
        `kw_${k}`,
        () => token(prec(0, ci(v))),
      ]),
    ),
    kw_function: () =>
      token(prec(0, seq(repeat(seq(MODIFIER, /[ \t]+/)), ci("function")))),
    kw_class_constructor: () =>
      token(prec(0, seq(repeat(seq(MODIFIER, /[ \t]+/)), ci("class constructor")))),
    kw_declare: () => token(prec(0, /#[dD][eE][cC][lL][aA][rR][eE]/)),
    kw_accessor: () => token(prec(0, seq(choice(ci("get"), ci("set"), ci("query"), ci("orderBy")), /[ \t]+/))),

    // ------------------------------------------------------------------
    // Statements
    // ------------------------------------------------------------------
    _statement: ($) =>
      choice(
        $.if_statement,
        $.while_statement,
        $.repeat_statement,
        $.for_statement,
        $.for_each_statement,
        $.case_statement,
        $.use_statement,
        $.try_statement,
        $.sql_block,
        $.var_declaration,
        $.property_declaration,
        $.function_definition,
        $.constructor_definition,
        $.class_extends,
        $.declare_statement,
        $.alias_statement,
        $.return_statement,
        $.throw_statement,
        $.break_statement,
        $.continue_statement,
        $.expression_statement,
      ),

    block: ($) => repeat1($._line),

    expression_statement: ($) => $._expression,

    if_statement: ($) =>
      seq(
        $.kw_if,
        field("condition", $._expression),
        field("body", optional($.block)),
        optional(
          seq($.kw_else, field("alternative", optional($.block))),
        ),
        $.kw_end_if,
      ),

    while_statement: ($) =>
      seq(
        $.kw_while,
        field("condition", $._expression),
        optional($.block),
        $.kw_end_while,
      ),

    repeat_statement: ($) =>
      seq(
        $.kw_repeat,
        optional($.block),
        $.kw_until,
        field("condition", $._expression),
      ),

    for_statement: ($) =>
      seq(
        $.kw_for,
        $.arguments,
        optional($.block),
        $.kw_end_for,
      ),

    for_each_statement: ($) =>
      seq(
        $.kw_for_each,
        $.arguments,
        optional(seq(choice($.kw_until, $.kw_while), $._expression)),
        optional($.block),
        $.kw_end_for_each,
      ),

    case_statement: ($) =>
      seq(
        $.kw_case_of,
        repeat($._nl),
        repeat($.case_clause),
        optional($.else_clause),
        $.kw_end_case,
      ),

    case_clause: ($) =>
      seq(
        ":",
        "(",
        field("condition", $._expression),
        ")",
        optional($.block),
      ),

    else_clause: ($) =>
      seq($.kw_else, optional($.block)),

    use_statement: ($) =>
      seq(
        $.kw_use,
        $.arguments,
        optional($.block),
        $.kw_end_use,
      ),

    try_statement: ($) =>
      seq(
        $.kw_try,
        choice(
          // Block form: Try ... Catch ... End try
          seq(
            optional($.block),
            optional(seq($.kw_catch, optional($.block))),
            $.kw_end_try,
          ),
        ),
      ),

    sql_block: ($) =>
      seq(
        $.kw_begin_sql,
        repeat(choice($.sql_line, $._nl)),
        $.kw_end_sql,
      ),

    sql_line: () => token(/[^\r\n]+/),

    // var $a; $b : Text   /   var $o : cs.MyClass := ...
    var_declaration: ($) =>
      prec.right(seq($.kw_var, sep1($.var_item, choice(",", ";")))),

    var_item: ($) =>
      prec.right(seq(
        field("name", $._var_ref),
        optional(
          seq(
            ":",
            field("type", $.type),
            optional(seq(":=", field("value", $._expression))),
          ),
        ),
      )),

    _var_ref: ($) => choice($.local_variable, $.interprocess_variable, $.name),

    property_declaration: ($) =>
      prec.right(seq(
        $.kw_property,
        sep1(field("name", $.name), choice(",", ";")),
        optional(seq(":", field("type", $.type))),
      )),

    function_definition: ($) =>
      prec.right(seq(
        $.kw_function,
        optional($.kw_accessor),
        field("name", alias($._word, $.name)),
        optional($.parameters),
        optional(seq("->", $.parameter)),
        optional($.return_type),
      )),

    constructor_definition: ($) =>
      prec.right(seq($.kw_class_constructor, optional($.parameters))),

    class_extends: ($) => prec.right(seq($.kw_extends, field("parent", $.type))),

    declare_statement: ($) =>
      prec.right(seq(
        $.kw_declare,
        $.parameters,
        optional(seq("->", sep1($.parameter, ";"))),
        optional($.return_type),
      )),

    alias_statement: ($) =>
      prec.right(seq($.kw_alias, field("name", alias($._word, $.name)), field("target", $._expression))),

    parameters: ($) =>
      seq("(", optional($._nl), optional(sep1($.parameter, ";")), ")"),

    parameter: ($) =>
      prec.right(seq(
        field("name", choice($.local_variable, $.name, "...")),
        optional(seq(":", field("type", $.type))),
      )),

    return_type: ($) => seq(":", field("type", $.type)),

    type: () => token(/[A-Za-z0-9_À-￿]+(\.[A-Za-z0-9_À-￿]+)*/),

    return_statement: ($) => prec.right(seq($.kw_return, optional($._expression))),
    throw_statement: ($) => prec.right(seq($.kw_throw, optional($._expression))),
    break_statement: ($) => $.kw_break,
    continue_statement: ($) => $.kw_continue,

    // ------------------------------------------------------------------
    // Expressions
    // ------------------------------------------------------------------
    _expression: ($) =>
      choice(
        $.assignment_expression,
        $.ternary_expression,
        $.binary_expression,
        $.unary_expression,
        $._postfix,
      ),

    assignment_expression: ($) =>
      prec.right(
        PREC.assign,
        seq(
          field("left", $._expression),
          field("operator", choice(":=", "+=", "-=", "*=", "/=", "%=")),
          field("right", $._expression),
        ),
      ),

    ternary_expression: ($) =>
      prec.right(
        PREC.ternary,
        seq(
          field("condition", $._expression),
          "?",
          field("consequence", $._expression),
          ":",
          field("alternative", $._expression),
        ),
      ),

    binary_expression: ($) => {
      const table = [
        [PREC.or, choice("|", "||", "^|")],
        [PREC.and, choice("&", "&&")],
        [PREC.compare, choice("=", "#", "<", ">", "<=", ">=")],
        [PREC.bitshift, choice("<<", ">>", "?+", "?-", "??")],
        [PREC.add, choice("+", "-")],
        [PREC.mul, choice("*", "/", "\\", "%")],
        [PREC.power, "**"],
      ];
      return choice(
        ...table.map(([p, op]) =>
          prec.left(
            p,
            seq(
              field("left", $._expression),
              field("operator", op),
              field("right", $._expression),
            ),
          ),
        ),
      );
    },

    unary_expression: ($) =>
      prec.left(
        PREC.unary,
        seq(field("operator", choice("-", "+", "->", "!")), field("argument", $._expression)),
      ),

    _postfix: ($) =>
      choice(
        $.call_expression,
        $.member_expression,
        $.subscript_expression,
        $.element_expression,
        $.dereference_expression,
        $._primary,
      ),

    call_expression: ($) =>
      prec.left(
        PREC.call,
        seq(field("function", $._postfix), field("arguments", $.arguments)),
      ),

    member_expression: ($) =>
      prec.left(
        PREC.postfix,
        seq(
          field("object", $._postfix),
          ".",
          field("property", $.name),
        ),
      ),

    subscript_expression: ($) =>
      prec.left(
        PREC.postfix,
        seq(field("object", $._postfix), "[", optional($._nl), field("index", $._expression), optional($._nl), "]"),
      ),

    element_expression: ($) =>
      prec.left(
        PREC.postfix,
        seq(field("array", $._postfix), "{", field("index", $._expression), "}"),
      ),

    dereference_expression: ($) =>
      prec.left(PREC.postfix, seq(field("pointer", $._postfix), "->")),

    arguments: ($) =>
      seq(
        "(",
        optional($._nl),
        optional(
          seq(
            optional($._expression),
            repeat(seq(";", optional($._nl), optional($._expression))),
          ),
        ),
        optional($._nl),
        ")",
      ),

    _primary: ($) =>
      choice(
        $.parenthesized_expression,
        $.object_literal,
        $.collection_literal,
        $.string,
        $.number,
        $.date_literal,
        $.time_literal,
        $.local_variable,
        $.parameter_reference,
        $.interprocess_variable,
        $.table_reference,
        $.boolean,
        $.null,
        $.this,
        $.super,
        $.name,
      ),

    parenthesized_expression: ($) =>
      seq("(", optional($._nl), $._expression, optional($._nl), ")"),

    object_literal: ($) =>
      seq(
        "{",
        repeat($._nl),
        optional(
          seq(
            $.pair,
            repeat(seq(repeat1(choice(",", ";", $._nl)), $.pair)),
            repeat(choice(",", ";", $._nl)),
          ),
        ),
        "}",
      ),

    pair: ($) =>
      seq(
        field("key", choice($.string, $.name)),
        ":",
        field("value", $._expression),
      ),

    collection_literal: ($) =>
      seq(
        "[",
        repeat($._nl),
        optional(
          seq(
            $._expression,
            repeat(seq(repeat1(choice(";", ",", $._nl)), $._expression)),
            repeat(choice(";", ",", $._nl)),
          ),
        ),
        "]",
      ),

    // [Table] or [Table]Field
    table_reference: ($) =>
      prec.right(seq($.table_name, optional(field("field", $.name)))),

    table_name: () =>
      token(/\[[A-Za-z_À-￿][A-Za-z0-9_À-￿ ]*(:[0-9]+)?\]/),

    // Identifiers: one or more words, with optional token suffix (:C13, :K24:5)
    name: ($) => prec.right(seq(repeat1($._word), optional($.token_suffix))),

    _word: () => WORD,

    token_suffix: () => token.immediate(/:[CK][0-9]+(:[0-9]+)?/),

    local_variable: () => token(/\$[A-Za-z0-9_À-￿]*/),
    parameter_reference: ($) => seq("$", "{", $._expression, "}"),
    interprocess_variable: () => token(/<>[A-Za-z_À-￿][A-Za-z0-9_À-￿]*/),

    string: ($) =>
      seq(
        '"',
        repeat(choice($.string_content, $.escape_sequence)),
        '"',
      ),
    string_content: () => token.immediate(prec(1, /[^"\\\r\n]+/)),
    escape_sequence: () => token.immediate(/\\./),

    number: () =>
      token(
        choice(
          /0[xX][0-9a-fA-F]+/,
          /[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/,
        ),
      ),
    date_literal: () => token(/![0-9]{1,4}[-\/][0-9]{1,2}[-\/][0-9]{1,4}!/),
    time_literal: () => token(/\?[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?\?/),

    boolean: ($) => choice($.kw_true, $.kw_false),
    null: ($) => $.kw_null,
    this: ($) => $.kw_this,
    super: ($) => $.kw_super,
  },
});
