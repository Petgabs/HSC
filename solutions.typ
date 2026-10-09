
#set page(
  paper: "a4",
  margin: (x: 1.5cm, top: 1.8cm, bottom: 1.8cm),
  header: context {
    if here().page() > 1 [
      #set text(size: 8pt, fill: rgb("#718096"), font: "New Computer Modern")
      #grid(
        columns: (1fr, auto),
        align: (left, right),
        [HSC Mathematics Advanced (Year 12) --- Practice Paper (MAD 12) Worked Solutions],
        [NESA Standard Solutions]
      )
      #v(-3pt)
      #line(length: 100%, stroke: 0.5pt + rgb("#CBD5E0"))
    ]
  },
  footer: context [
    #set text(size: 8pt, fill: rgb("#718096"), font: "New Computer Modern")
    #line(length: 100%, stroke: 0.5pt + rgb("#CBD5E0"))
    #v(-3pt)
    #grid(
      columns: (1fr, auto),
      align: (left, right),
      [NSW Stage 6 Mathematics Advanced | NESA Reference Sheet Aligned | LaTeX Typography],
      [Page #here().page() of #counter(page).final().first()]
    )
  ]
)

#set text(font: "New Computer Modern", size: 9pt)
#set par(justify: true, leading: 0.52em)

// Banner on Page 1
#block(
  width: 100%,
  stroke: (bottom: 1.5pt + rgb("#1A365D")),
  inset: (bottom: 6pt),
  [
    #grid(
      columns: (1fr, auto),
      align: (left, right),
      [
        #text(size: 16pt, weight: "bold", fill: rgb("#1A365D"))[HSC Mathematics Advanced (Year 12)] \
        #v(1pt)
        #text(size: 10pt, weight: "bold", fill: rgb("#2B6CB0"))[Official NESA Standard Solutions & Marking Guidelines] \
        #text(size: 8pt, fill: rgb("#4A5568"))[Trial Examination Practice Paper (MAD 12) | Proper LaTeX Mathematical Typography]
      ],
      [
        #align(right)[
          #text(size: 8pt, fill: rgb("#4A5568"))[
            *Curriculum:* NSW NESA Stage 6 \
            *Paper:* MAD 12 Revision \
            *Font:* Computer Modern (CM) \
            *Formulas:* NESA Reference Sheet
          ]
        ]
      ]
    )
  ]
)
#v(6pt)

#let q-card(
  q-num,
  marks,
  topic,
  question,
  formula,
  working,
  final-ans,
  criteria,
  diagram: none
) = block(
  width: 100%,
  stroke: 0.5pt + rgb("#CBD5E0"),
  radius: 3pt,
  clip: true,
  breakable: false,
  [
    #block(
      fill: rgb("#EDF2F7"),
      inset: (x: 8pt, y: 4pt),
      width: 100%,
      stroke: (bottom: 0.5pt + rgb("#CBD5E0")),
      [
        #grid(
          columns: (1fr, auto),
          [#text(weight: "bold", fill: rgb("#1A365D"))[QUESTION #q-num] #h(6pt) | #h(6pt) #text(fill: rgb("#4A5568"))[#topic]],
          [#text(weight: "bold", fill: rgb("#2B6CB0"))[[#marks Marks]]]
        )
      ]
    )
    #pad(x: 8pt, top: 5pt, bottom: 5pt)[
      #block(
        fill: rgb("#F8FAFC"),
        stroke: 0.5pt + rgb("#E2E8F0"),
        radius: 2pt,
        inset: 6pt,
        width: 100%,
        [*Question:* #question]
      )
      #v(3pt)
      #if formula != none [
        #block(
          fill: rgb("#EBF8FF"),
          stroke: 0.5pt + rgb("#BEE3F8"),
          radius: 2pt,
          inset: 5pt,
          width: 100%,
          [
            #text(size: 8pt, fill: rgb("#2C5282"))[
              *NESA Reference Sheet / Key Rule:* \
              #formula
            ]
          ]
        )
        #v(3pt)
      ]
      #text(weight: "bold", fill: rgb("#2B6CB0"), size: 8.5pt)[Detailed Working (NESA Standard Solution):] \
      #v(1pt)
      #working
      #if diagram != none [
        #v(2pt)
        #align(center, diagram)
        #v(2pt)
      ]
      #v(3pt)
      #block(
        fill: rgb("#F0FFF4"),
        stroke: 0.7pt + rgb("#38A169"),
        radius: 2pt,
        inset: 5pt,
        width: 100%,
        [
          #text(fill: rgb("#22543D"), weight: "bold", size: 8.5pt)[*Final Answer:* #final-ans]
        ]
      )
      #v(3pt)
      #if criteria != () [
        #table(
          columns: (65pt, 1fr),
          stroke: 0.35pt + rgb("#CBD5E0"),
          fill: (col, row) => if row == 0 { rgb("#EDF2F7") } else { none },
          inset: 3.5pt,
          [#text(size: 7pt, weight: "bold", fill: rgb("#1A365D"))[Marks]],
          [#text(size: 7pt, weight: "bold", fill: rgb("#1A365D"))[Marking Criteria Breakdown]],
          ..criteria.map(c => (
            text(size: 7pt, weight: "bold", fill: rgb("#2D3748"))[#c.at(0)],
            text(size: 7pt, fill: rgb("#4A5568"))[#c.at(1)]
          )).flatten()
        )
      ]
    ]
  ]
)

// ==================== QUESTION 1 ====================
#q-card(
  1, 2, "Integral Calculus --- Linear Substitution",
  [Find $integral sqrt(4x + 1) dif x$.],
  [$integral (a x + b)^n dif x = ((a x + b)^(n+1)) / (a(n + 1)) + c, quad "where" n != -1$],
  [
    + Express the integrand in fractional index form:
      $ integral sqrt(4x + 1) dif x = integral (4x + 1)^(1/2) dif x $
    + Identify linear parameters: $a = 4$, $b = 1$, and power $n = 1/2$.
    + Apply the linear composite primitive rule:
      $ integral (4x + 1)^(1/2) dif x = ((4x + 1)^(1/2 + 1)) / (4 dot (1/2 + 1)) + C = ((4x + 1)^(3/2)) / (4 dot 3/2) + C = 1/6 (4x + 1)^(3/2) + C $
  ],
  [$1/6 (4x + 1)^(3/2) + C quad "or" quad (sqrt((4x + 1)^3)) / 6 + C$],
  (
    ("1 Mark", "Expresses integrand in index form and applies linear rule (divides by 4 and adds 1 to power)."),
    ("1 Mark", "Simplifies denominator to 6 and includes constant of integration + C.")
  )
)

#v(4pt)

// ==================== QUESTION 2 ====================
#q-card(
  2, 2, "Differential Calculus --- Increasing Functions",
  [For the function $f(x) = x^3 - 9x$, state the domain where $f(x)$ is increasing.],
  [A differentiable function $f(x)$ is increasing on an interval where $f'(x) >= 0$ (or strictly increasing where $f'(x) > 0$).],
  [
    + Find the first derivative:
      $ f'(x) = dif / (dif x) (x^3 - 9x) = 3x^2 - 9 $
    + Set up the condition for an increasing function:
      $ f'(x) >= 0 arrow.r.double 3x^2 - 9 >= 0 arrow.r.double 3(x^2 - 3) >= 0 arrow.r.double x^2 >= 3 $
    + Solve the quadratic inequality:
      $ x <= -sqrt(3) quad "or" quad x >= sqrt(3) quad "or in interval notation:" (-infinity, -sqrt(3)] union [sqrt(3), infinity) $
      _(Note: NESA marking criteria accepts both non-strict $x <= -sqrt(3) "or" x >= sqrt(3)$ and strict $x < -sqrt(3) "or" x > sqrt(3)$)._
  ],
  [$x <= -sqrt(3) quad "or" quad x >= sqrt(3) quad ((-infinity, -sqrt(3)] union [sqrt(3), infinity))$],
  (
    ("1 Mark", "Differentiates correctly to obtain $f'(x) = 3x^2 - 9$."),
    ("1 Mark", "Solves inequality $f'(x) >= 0$ to state exact domain in terms of $plus.minus sqrt(3)$.")
  )
)

#v(4pt)

// ==================== QUESTION 3 ====================
#q-card(
  3, 2, "Integral Calculus --- Logarithmic Integrals",
  [Find $integral e^(3x) / (e^(3x) + 1) dif x$.],
  [$integral (f'(x)) / (f(x)) dif x = ln |f(x)| + c$],
  [
    + Recognise that the numerator is a scalar multiple of the derivative of the denominator:
      $ "Let" f(x) = e^(3x) + 1 arrow.r.double f'(x) = 3e^(3x) $
    + Balance the scalar multiplier:
      $ integral e^(3x) / (e^(3x) + 1) dif x = 1/3 integral (3e^(3x)) / (e^(3x) + 1) dif x $
    + Integrate using the standard logarithmic primitive:
      $ = 1/3 ln(e^(3x) + 1) + C $
      _(Absolute value signs are not required since $e^(3x) + 1 > 0$ for all real $x$)._
  ],
  [$1/3 ln(e^(3x) + 1) + C$],
  (
    ("1 Mark", "Recognises the $(f'(x))/(f(x))$ form and balances with constant factor $1/3$."),
    ("1 Mark", "Obtains correct primitive including constant of integration $+ C$.")
  )
)



// ==================== QUESTION 4 ====================
#q-card(
  4, 4, "Calculus --- Chain Rule & Reverse Chain Rule",
  [
    *a.* Find $dif / (dif x) (sqrt(x) + 1)^3$ \
    *b.* Hence, find $integral ((sqrt(x) + 1)^2) / (2sqrt(x)) dif x$
  ],
  [Chain Rule: $dif / (dif x) [g(x)]^n = n [g(x)]^(n-1) g'(x)$],
  [
    *Part a (Differentiating via Chain Rule):*
    - Let $g(x) = sqrt(x) + 1 = x^(1/2) + 1 arrow.r.double g'(x) = 1/2 x^(-1/2) = 1 / (2sqrt(x))$.
    - Differentiating:
      $ dif / (dif x) [(sqrt(x) + 1)^3] = 3(sqrt(x) + 1)^2 dot 1 / (2sqrt(x)) = (3(sqrt(x) + 1)^2) / (2sqrt(x)) $

    *Part b (Using 'Hence' to integrate):*
    - From Part (a), we have the exact differential relationship:
      $ dif / (dif x) [(sqrt(x) + 1)^3] = 3 dot ((sqrt(x) + 1)^2) / (2sqrt(x)) $
    - Integrating both sides with respect to $x$:
      $ 3 integral ((sqrt(x) + 1)^2) / (2sqrt(x)) dif x = (sqrt(x) + 1)^3 + C_1 $
    - Dividing by 3:
      $ integral ((sqrt(x) + 1)^2) / (2sqrt(x)) dif x = 1/3 (sqrt(x) + 1)^3 + C $
  ],
  [*a.* $(3(sqrt(x) + 1)^2) / (2sqrt(x)) quad$ | $quad$ *b.* $1/3 (sqrt(x) + 1)^3 + C$],
  (
    ("2 Marks (a)", "1 mark for chain rule application; 1 mark for correct simplified derivative."),
    ("2 Marks (b)", "1 mark for relating integral to derivative of Part a; 1 mark for primitive with $+ C$.")
  )
)

#v(6pt)

// ==================== QUESTION 5 ====================
#q-card(
  5, 3, "Sequences and Series --- Arithmetic Progression (AP)",
  [On the first day of the harvest, an orchard produces $1630 "kg"$ of fruit. On the next day, the orchard produces $1605 "kg"$, and the amount produced continues to decrease by the same amount each day. On what day does the daily production first fall below $600 "kg"$?],
  [$n"-th term of an Arithmetic Progression:" quad T_n = a + (n - 1)d$],
  [
    + *Identify AP parameters:*
      - First term: $a = 1630$
      - Common difference: $d = 1605 - 1630 = -25$
    + *State the general $n$-th term formula:*
      $ T_n = 1630 + (n - 1)(-25) = 1630 - 25n + 25 = 1655 - 25n $
    + *Form and solve the inequality $T_n < 600$:*
      $ 1655 - 25n < 600 arrow.r.double -25n < 600 - 1655 arrow.r.double -25n < -1055 $
      Reversing the inequality when dividing by negative:
      $ n > (-1055) / (-25) arrow.r.double n > 42.2 $
    + *Conclusion:* Since $n$ represents discrete days, the daily production first falls below $600 "kg"$ on day $n = 43$. \
      _(Verification: $T_42 = 1630 + 41(-25) = 605 "kg"$; $quad T_43 = 1630 + 42(-25) = 580 "kg" < 600 "kg"$)._
  ],
  [Day 43 (or the 43rd day)],
  (
    ("1 Mark", "Identifies $a = 1630, d = -25$ and sets up expression for $T_n$."),
    ("1 Mark", "Sets up inequality $T_n < 600$ and solves for $n > 42.2$."),
    ("1 Mark", "Correctly concludes Day 43.")
  )
)



// ==================== QUESTION 6 ====================
#q-card(
  6, 7, "Differential Calculus --- Curve Sketching & Nature of Stationary Points",
  [
    Consider the curve $y = x^3 - 6x^2 + 9x + 3$. \
    *(a)* Find the location and nature of any stationary points. \
    *(b)* Find the point of inflection. \
    *(c)* Sketch the curve $y = x^3 - 6x^2 + 9x + 3$ labelling the stationary points, the point of inflection and $y$-intercepts. The $x$-intercepts are not required.
  ],
  [Stationary points: $y' = 0$. Nature: $y'' < 0$ (Local Max), $y'' > 0$ (Local Min). Inflection: $y'' = 0$ with concavity change.],
  [
    *(a) Stationary Points and Their Nature:*
    - First derivative:
      $ y' = dif y / (dif x) = 3x^2 - 12x + 9 = 3(x^2 - 4x + 3) = 3(x - 1)(x - 3) $
    - Stationary points occur where $y' = 0$:
      $ 3(x - 1)(x - 3) = 0 arrow.r.double x = 1 quad "or" quad x = 3 $
    - Corresponding $y$-coordinates:
      - At $x = 1$: $y = (1)^3 - 6(1)^2 + 9(1) + 3 = 1 - 6 + 9 + 3 = 7 arrow.r.double (1, 7)$
      - At $x = 3$: $y = (3)^3 - 6(3)^2 + 9(3) + 3 = 27 - 54 + 27 + 3 = 3 arrow.r.double (3, 3)$
    - Nature via the second derivative:
      $ y'' = dif^2 y / (dif x^2) = 6x - 12 $
      - At $x = 1$: $y''(1) = 6(1) - 12 = -6 < 0 arrow.r.double$ *Local Maximum at $(1, 7)$*
      - At $x = 3$: $y''(3) = 6(3) - 12 = +6 > 0 arrow.r.double$ *Local Minimum at $(3, 3)$*

    *(b) Point of Inflection:*
    - Potential inflection points occur where $y'' = 0$:
      $ 6x - 12 = 0 arrow.r.double 6x = 12 arrow.r.double x = 2 $
    - At $x = 2$: $y = (2)^3 - 6(2)^2 + 9(2) + 3 = 8 - 24 + 18 + 3 = 5 arrow.r.double (2, 5)$
    - Concavity test:
      - For $x < 2$ (e.g. $x = 1$): $y''(1) = -6 < 0$ (concave downwards)
      - For $x > 2$ (e.g. $x = 3$): $y''(3) = +6 > 0$ (concave upwards)
    - Since concavity changes sign across $x = 2$, *(2, 5) is a true point of inflection*.

    *(c) Curve Sketch:*
    - $y$-intercept: Let $x = 0 arrow.r.double y = 3 arrow.r.double (0, 3)$.
  ],
  [*(a)* Local Maximum at $(1, 7)$; Local Minimum at $(3, 3)$ \ *(b)* Point of Inflection at $(2, 5)$ \ *(c)* See plotted cubic curve below.],
  (
    ("3 Marks (a)", "1 mark for $y'=0$ and $x=1, 3$; 1 mark for points $(1,7)$ & $(3,3)$; 1 mark for nature test."),
    ("2 Marks (b)", "1 mark for finding $(2, 5)$; 1 mark for testing concavity change across $x=2$."),
    ("2 Marks (c)", "1 mark for correct cubic profile; 1 mark for labelling $(0, 3)$, $(1, 7)$, $(2, 5)$, and $(3, 3)$.")
  ),
  diagram: image("q6_curve_cm.png", width: 75%)
)



// ==================== QUESTION 7 ====================
#q-card(
  7, 3, "Calculus --- Tangents & Normals to Logarithmic Curves",
  [A curve has the equation $y = log_e(x^3 - 5)$. Find the equation of the normal to the curve at the point $x = 2$.],
  [$dif / (dif x) [ln f(x)] = (f'(x)) / (f(x)), quad m_("normal") = -1 / m_("tangent"), quad y - y_1 = m(x - x_1)$],
  [
    + *Find coordinates of the point:*
      At $x = 2$: $y = ln(2^3 - 5) = ln(8 - 5) = ln 3$. The point is $(2, ln 3)$.
    + *Differentiate to find tangent gradient:*
      $ dif y / (dif x) = (dif / (dif x) (x^3 - 5)) / (x^3 - 5) = (3x^2) / (x^3 - 5) $
      At $x = 2$:
      $ m_("tangent") = (3(2)^2) / (2^3 - 5) = 12 / 3 = 4 $
    + *Determine normal gradient:*
      $ m_("normal") = -1 / m_("tangent") = -1/4 $
    + *Establish equation of normal line:*
      $ y - ln 3 = -1/4 (x - 2) arrow.r.double 4(y - ln 3) = -(x - 2) $
      $ 4y - 4 ln 3 = -x + 2 arrow.r.double x + 4y - (2 + 4 ln 3) = 0 quad "or" quad y = -1/4 x + 1/2 + ln 3 $
  ],
  [$x + 4y - (2 + 4 ln 3) = 0 quad (y = -1/4 x + 1/2 + ln 3)$],
  (
    ("1 Mark", "Finds point $(2, ln 3)$ and calculates $dif y / (dif x) = (3x^2)/(x^3 - 5)$."),
    ("1 Mark", "Calculates $m_(\"tangent\") = 4$ and $m_(\"normal\") = -1/4$."),
    ("1 Mark", "Forms correct exact equation of the normal.")
  )
)

#v(6pt)

// ==================== QUESTION 8 ====================
#q-card(
  8, 3, "Trigonometric Functions --- Quadratic Equations",
  [Solve $2 cos^2 x + 3 cos x + 1 = 0$ for $0 <= x <= 2 pi$.],
  [Factorise quadratic in $cos x$; solve in radians across quadrants in $[0, 2 pi]$.],
  [
    + *Factorise the trigonometric quadratic:*
      $ (2 cos x + 1)(cos x + 1) = 0 $
    + *Solve each factor:*
      $ cos x = -1/2 quad "or" quad cos x = -1 $
    + *Determine radian solutions in $[0, 2 pi]$:*
      - *Case 1:* $cos x = -1 arrow.r.double x = pi$
      - *Case 2:* $cos x = -1/2$
        - Reference angle: $cos theta = 1/2 arrow.r.double theta = pi/3$
        - Cosine is negative in Quadrants II and III:
          $ "Quadrant II:" quad x = pi - pi/3 = (2pi)/3 $
          $ "Quadrant III:" quad x = pi + pi/3 = (4pi)/3 $
  ],
  [$x = (2pi)/3, quad pi, quad (4pi)/3$],
  (
    ("1 Mark", "Factorises quadratic correctly to $(2cos x + 1)(cos x + 1) = 0$."),
    ("1 Mark", "Obtains boundary solution $x = pi$ from $cos x = -1$."),
    ("1 Mark", "Obtains both exact quadrant solutions $x = (2pi)/3$ and $x = (4pi)/3$.")
  )
)



// ==================== QUESTION 9 ====================
#q-card(
  9, 2, "Functions --- Absolute Value Equations",
  [Solve the equation $|2x + 3| = 7$.],
  [$|X| = a arrow.r.double.long X = a quad "or" quad X = -a quad (a >= 0)$],
  [
    + By definition of absolute value, split into two linear cases:
      $ 2x + 3 = 7 quad "or" quad 2x + 3 = -7 $
    + Solve each linear equation:
      - *Case 1:* $2x = 7 - 3 = 4 arrow.r.double x = 2$
      - *Case 2:* $2x = -7 - 3 = -10 arrow.r.double x = -5$
  ],
  [$x = 2 quad "or" quad x = -5$],
  (
    ("1 Mark", "Splits absolute value into two cases: $2x + 3 = plus.minus 7$."),
    ("1 Mark", "Calculates both correct solutions $x = 2$ and $x = -5$.")
  )
)

#v(5pt)

// ==================== QUESTION 10 ====================
#q-card(
  10, 3, "Calculus --- Product and Chain Rules",
  [Find the derivative of $y = sin 5x tan(e^x)$.],
  [$(u v)' = u'v + u v', quad dif / (dif x) [sin k x] = k cos k x, quad dif / (dif x) [tan f(x)] = f'(x) sec^2 f(x)$],
  [
    + *Identify factors for Product Rule:*
      - Let $u = sin 5x arrow.r.double u' = 5 cos 5x$
      - Let $v = tan(e^x) arrow.r.double v' = sec^2(e^x) dot dif / (dif x)(e^x) = e^x sec^2(e^x)$
    + *Apply product rule formula:*
      $ dif y / (dif x) = u'v + u v' = 5 cos 5x tan(e^x) + e^x sin 5x sec^2(e^x) $
  ],
  [$dif y / (dif x) = 5 cos 5x tan(e^x) + e^x sin 5x sec^2(e^x)$],
  (
    ("1 Mark", "Correct application of product rule."),
    ("1 Mark", "Correctly differentiates either $u$ or $v$ using the chain rule."),
    ("1 Mark", "Obtains complete, correct derivative expression.")
  )
)

#v(5pt)

// ==================== QUESTION 11 ====================
#q-card(
  11, 3, "Functions --- Composite Functions (Domain and Range)",
  [Given $f(x) = sqrt(x + 1)$ and $g(x) = 2x - 3$. Find the domain and range of $f(g(x))$.],
  [Radicand of square root must be non-negative ($>= 0$); principal square root produces non-negative outputs ($>= 0$).],
  [
    + *Form composite function:*
      $ f(g(x)) = f(2x - 3) = sqrt((2x - 3) + 1) = sqrt(2x - 2) $
    + *Determine Domain:*
      For a real square root, the expression under the radical must be non-negative:
      $ 2x - 2 >= 0 arrow.r.double 2x >= 2 arrow.r.double x >= 1 quad "or" quad [1, infinity) $
    + *Determine Range:*
      - At $x = 1$: $f(g(1)) = sqrt(2(1) - 2) = sqrt(0) = 0$.
      - As $x -> infinity$, $2x - 2 -> infinity arrow.r.double sqrt(2x - 2) -> infinity$.
      - Since $sqrt(dot)$ denotes the principal (non-negative) square root:
        $ y >= 0 quad "or" quad f(g(x)) >= 0 quad "or" quad [0, infinity) $
  ],
  [Domain: $x >= 1 quad ([1, infinity)) quad$ | $quad$ Range: $y >= 0 quad ([0, infinity))$],
  (
    ("1 Mark", "Forms composite expression $f(g(x)) = sqrt(2x - 2)$."),
    ("1 Mark", "Finds correct domain $x >= 1$."),
    ("1 Mark", "Finds correct range $y >= 0$.")
  )
)



// ==================== QUESTION 12 ====================
#q-card(
  12, 6, "Statistical Analysis --- Bivariate Data, Linear Regression & Extrapolation",
  [
    Tom surveyed age ($x$) and weekly wage ($W$): \
    #align(center)[
      #table(
        columns: (80pt, 35pt, 35pt, 35pt, 35pt, 35pt, 35pt),
        inset: 4pt,
        align: center,
        [*Age (years) ($x$)*], [18], [45], [28], [15], [32], [68],
        [*Wage (\$/week) ($W$)*], [715], [2350], [1530], [438], [1690], [1320]
      )
    ]
    *i.* Using your calculator, find correlation coefficient ($r$), and explain strength. \
    *ii.* Find least-squares regression line in form $W = B x + A$, where $A$ and $B$ are integers. \
    *iii.* Could your equation be used to make valid estimate for ages $> 68$ or $< 15$ years? Justify.
  ],
  [$r = "Pearson's correlation coefficient", quad W = B x + A "least-squares line"$],
  [
    *Part i (Correlation coefficient):*
    - From 2-variable calculator linear statistics:
      $ r approx 0.52632 approx 0.53 $
    - *Interpretation:* There is a *moderate positive linear correlation* between age and weekly wage.

    *Part ii (Least-squares regression line):*
    - Slope: $B = (n sum x W - sum x sum W) / (n sum x^2 - (sum x)^2) = 18.4795 arrow.r.double B = 18$ (nearest integer).
    - Intercept: $A = overline(W) - B overline(x) = 706.038 arrow.r.double A = 706$ (nearest integer).
    - Regression equation:
      $ W = 18x + 706 $

    *Part iii (Validity / Extrapolation):*
    - *Answer:* *No*, the equation cannot be used to make valid estimates.
    - *Justification:*
      + *Statistical Extrapolation:* Predicting outside the observed sample range $[15, 68]$ is extrapolation. Extrapolation is inherently unreliable because a linear trend cannot be assumed to continue indefinitely.
      + *Contextual Reasons:*
        - For ages $> 68$, individuals commonly retire and their wage income decreases significantly; the linear equation falsely predicts continuously increasing earnings.
        - For ages $< 15$, individuals are school children not legally working full-time; yet the model unrealistically predicts a wage of $\$706$ per week at age 0 ($x = 0$).
  ],
  [*i.* $r approx 0.53$ (moderate positive linear correlation) \ *ii.* $W = 18x + 706$ \ *iii.* No; extrapolation outside $[15, 68]$ is unreliable and unrealistic in reality.],
  (
    ("2 Marks (i)", "1 mark for $r approx 0.53$; 1 mark for describing as moderate positive linear correlation."),
    ("2 Marks (ii)", "1 mark for finding slope & intercept; 1 mark for integer equation $W = 18x + 706$."),
    ("2 Marks (iii)", "1 mark for identifying extrapolation outside $[15, 68]$; 1 mark for valid practical justification.")
  )
)



// ==================== QUESTION 13 ====================
#q-card(
  13, 4, "Calculus / Differential Equations --- Exponential Growth",
  [
    The average life cycle of an insect is one month. The population $P$ grows so that:
    $ (dif P) / (dif t) = 1200 e^(0.3t) $
    A nest had a population of 5000 after one month ($t = 1$). Determine how long it will take the nest to reach the viable stage of at least $100 000$. Answer correct to the nearest month.
  ],
  [$integral e^(k t) dif t = 1/k e^(k t) + c$],
  [
    + *Integrate the differential rate equation:*
      $ P(t) = integral 1200 e^(0.3t) dif t = 1200 / 0.3 e^(0.3t) + C = 4000 e^(0.3t) + C $
    + *Use initial condition $t = 1, P(1) = 5000$ to solve for $C$:*
      $ 5000 = 4000 e^(0.3(1)) + C arrow.r.double C = 5000 - 4000 e^(0.3) $
      $ C approx 5000 - 4000(1.349859) = 5000 - 5399.435 = -399.435 $
    + *State the population function:*
      $ P(t) = 4000 e^(0.3t) - 399.435 $
    + *Solve for $t$ when $P(t) = 100 000$:*
      $ 4000 e^(0.3t) - 399.435 = 100 000 arrow.r.double 4000 e^(0.3t) = 100 399.435 $
      $ e^(0.3t) = (100 399.435) / 4000 = 25.09986 $
      Taking the natural logarithm:
      $ 0.3t = ln(25.09986) approx 3.22286 arrow.r.double t = (3.22286) / 0.3 approx 10.74 "months" $
    + *Round to nearest month:* $t approx 11$ months.
  ],
  [11 months],
  (
    ("1 Mark", "Integrates correctly to obtain $P(t) = 4000 e^(0.3t) + C$."),
    ("1 Mark", "Substitutes $t = 1, P = 5000$ to find $C = 5000 - 4000e^(0.3) approx -399.44$."),
    ("1 Mark", "Sets $P(t) = 100 000$ and solves for $t approx 10.74$."),
    ("1 Mark", "Rounds correctly to the nearest month (11 months).")
  )
)

#v(6pt)

// ==================== QUESTION 14 ====================
#q-card(
  14, 3, "Continuous Probability --- Normal Distribution",
  [Weights of bags of red gravel are modelled by a normal distribution with mean $25.8 "kg"$ and standard deviation $0.5 "kg"$. Using the provided standard normal cumulative table, find the probability that a bag weighs between $25.5 "kg"$ and $26.5 "kg"$.],
  [$Z = (X - mu) / sigma, quad P(a <= X <= b) = Phi(z_2) - Phi(z_1), quad Phi(-z) = 1 - Phi(z)$],
  [
    + *Calculate $z$-scores for the boundary values ($mu = 25.8, sigma = 0.5$):*
      - For $x_1 = 25.5 "kg"$: $z_1 = (25.5 - 25.8) / 0.5 = (-0.3) / 0.5 = -0.6$
      - For $x_2 = 26.5 "kg"$: $z_2 = (26.5 - 25.8) / 0.5 = 0.7 / 0.5 = 1.4$
    + *Express probability via the standard normal cumulative function $Phi(z)$:*
      $ P(25.5 <= X <= 26.5) = P(-0.6 <= Z <= 1.4) = Phi(1.4) - Phi(-0.6) $
    + *Extract probabilities from provided table:*
      - For $z = 1.4$: Row `1.`, Col `.4` $arrow.r.double Phi(1.4) = 0.9192$.
      - For $z = -0.6$: By symmetry of standard normal distribution:
        $ Phi(-0.6) = 1 - Phi(0.6) $
        From table (Row `0.`, Col `.6`): $Phi(0.6) = 0.7257$.
        $ Phi(-0.6) = 1 - 0.7257 = 0.2743 $
    + *Compute final probability:*
      $ P(-0.6 <= Z <= 1.4) = 0.9192 - 0.2743 = 0.6449 quad (64.49%) $
  ],
  [$0.6449 quad (64.49%)$],
  (
    ("1 Mark", "Standardises both values to $z_1 = -0.6$ and $z_2 = 1.4$."),
    ("1 Mark", "Extracts $Phi(1.4) = 0.9192$ and computes $Phi(-0.6) = 1 - 0.7257 = 0.2743$ from table."),
    ("1 Mark", "Evaluates final difference $0.6449$.")
  ),
  diagram: image("q14_normal_cm.png", width: 75%)
)



// ==================== QUESTION 15 ====================
#q-card(
  15, 6, "Calculus / Optimization --- Mensuration & Cost Minimization",
  [
    Harvey is designing an open-ended tent as shown below. The frame is made using rods of two lengths:
    - $x$ metres for top and bottom edges
    - $y$ metres for each sloping edge.
    Rods cost $\$9.50$ per metre. The frame is covered by one rectangular sheet of fabric of area $24 "m"^2$. \
    *(a)* Show that the total length, $l "m"$, of rods is given by $l = 3x + 48/x$. \
    *(b)* Find the value of $x$ for which $l$ is a minimum. \
    *(c)* What is the minimum cost of the frame?
  ],
  [Fabric area $= 2x y = 24$. Stationary point: $(dif l) / (dif x) = 0$. Minimum test: $(dif^2 l) / (dif x^2) > 0$.],
  [
    *(a) Show that $l = 3x + 48/x$:*
    - Rods of length $x$: 1 top horizontal ridge $+ 2$ bottom horizontal ground edges $= 3$ rods of length $x$.
    - Rods of length $y$: 2 sloping rods at front triangular opening $+ 2$ at back opening $= 4$ rods of length $y$.
    - Total length of rods:
      $ l = 3x + 4y $
    - The fabric is one continuous rectangular sheet draped over the ridge covering both sloping roofs:
      - Sheet length $= x$, sheet width $= y + y = 2y$.
      - Fabric Area $= x(2y) = 2x y = 24 arrow.r.double y = 24 / (2x) = 12 / x$.
    - Substituting $y$ into $l$:
      $ l = 3x + 4(12 / x) = 3x + 48 / x quad "(Shown)" $

    *(b) Find $x$ for which $l$ is a minimum:*
    - Differentiate $l$ with respect to $x$:
      $ dif l / (dif x) = dif / (dif x) (3x + 48 x^(-1)) = 3 - 48 x^(-2) = 3 - 48 / x^2 $
    - Stationary points occur where $(dif l) / (dif x) = 0$:
      $ 3 - 48 / x^2 = 0 arrow.r.double 3x^2 = 48 arrow.r.double x^2 = 16 arrow.r.double x = 4 "m" quad ("since" x > 0) $
    - Verify minimum using the second derivative test:
      $ dif^2 l / (dif x^2) = dif / (dif x) (3 - 48 x^(-2)) = 96 x^(-3) = 96 / x^3 $
      At $x = 4$:
      $ (dif^2 l) / (dif x^2) = 96 / (4^3) = 96 / 64 = 1.5 > 0 $
      Since $(dif^2 l) / (dif x^2) > 0$, the total length $l$ is a *minimum at $x = 4 "m"$*.

    *(c) Minimum cost of the frame:*
    - Total minimum rod length: $l(4) = 3(4) + 48/4 = 12 + 12 = 24 "m"$.
    - Total cost:
      $ "Cost" = 24 "m" times \$9.50/"m" = \$228.00 $
  ],
  [*(a)* Shown: $l = 3x + 48/x$ \ *(b)* $x = 4 "m"$ (confirmed minimum via $(dif^2 l)/(dif x^2) = 1.5 > 0$) \ *(c)* $\$228.00$],
  (
    ("2 Marks (a)", "1 mark for $l = 3x + 4y$ and $2xy = 24$; 1 mark for substituting $y = 12/x$ to obtain $l = 3x + 48/x$."),
    ("3 Marks (b)", "1 mark for $(dif l)/(dif x) = 3 - 48/x^2$; 1 mark for $x = 4$; 1 mark for verifying minimum."),
    ("1 Mark (c)", "1 mark for calculating $l = 24 \"m\"$ and total cost $\$228.00$.")
  ),
  diagram: image("q15_tent_cm.png", width: 65%)
)

#v(6pt)

// ==================== QUESTION 16 ====================
#q-card(
  16, 3, "Financial Mathematics --- Future Value of Annuities",
  [
    A table of future value interest factors for an annuity of $\$1$ is shown: \
    #align(center)[
      #table(
        columns: (45pt, 40pt, 40pt, 40pt, 40pt, 40pt, 40pt),
        inset: 3.5pt,
        align: center,
        [*Period*], [*1%*], [*4%*], [*8%*], [*12%*], [*16%*], [*20%*],
        [1], [1.0000], [1.0000], [1.0000], [1.0000], [1.0000], [1.0000],
        [2], [2.0100], [2.0400], [2.0800], [2.1200], [2.1600], [2.2000],
        [3], [3.0301], [3.1216], [3.2464], [3.3744], [3.5056], [3.6400],
        [4], [4.0604], [*4.2465*], [4.5061], [4.7793], [5.0665], [5.3680],
        [5], [5.1010], [5.4163], [5.8666], [6.3528], [6.8771], [7.4416],
        [6], [6.1520], [6.6330], [7.3359], [8.1152], [8.9775], [9.9299]
      )
    ]
    Annie wants to save $\$10 000$ over 2 years by investing equal payments every 6 months at $8\% "p.a."$ compounded half-yearly. What should be the value of each payment?
  ],
  [$"Future Value" = "Payment" (M) times "Table Factor", quad n = "periods", quad r = "rate per period"$],
  [
    + *Determine number of periods ($n$) and interest rate per period ($r$):*
      - Total time $= 2$ years.
      - Payment frequency $=$ every 6 months (half-yearly).
      - Compounding periods: $n = 2 times 2 = 4$ periods.
      - Interest rate per half-year: $r = (8\% "p.a.") / 2 = 4\%$ per half-year.
    + *Extract the factor from the provided table:*
      - Row: $"Period" = 4$
      - Column: $4\%$
      - Table Factor $= 4.2465$
    + *Calculate payment amount ($M$):*
      $ "Future Value" = M times 4.2465 $
      $ \$10 000 = M times 4.2465 arrow.r.double M = (10 000) / (4.2465) = 2354.880489... $
    + *Round to nearest cent:* $M = \$2354.88$.
  ],
  [\$2354.88],
  (
    ("1 Mark", "Identifies $n = 4$ periods and $r = 4\%$ rate per period."),
    ("1 Mark", "Extracts correct factor $4.2465$ from the annuity table."),
    ("1 Mark", "Calculates payment $M = \$2354.88$ rounded to the nearest cent.")
  )
)



// ==================== SUMMARY TABLE ====================
#text(size: 16pt, weight: "bold", fill: rgb("#1A365D"))[Summary of All Final Answers (Questions 1 to 16)] \
#v(2pt)
#text(size: 9.5pt, weight: "bold", fill: rgb("#2B6CB0"))[Quick Reference Table Aligned to NESA Marking Standards]
#v(6pt)

#table(
  columns: (30pt, 160pt, 1fr),
  stroke: 0.4pt + rgb("#CBD5E0"),
  fill: (col, row) => if row == 0 { rgb("#1A365D") } else if calc.even(row) { rgb("#F8FAFC") } else { none },
  inset: 4.5pt,
  [#text(weight: "bold", fill: white, size: 8pt)[Q\#]],
  [#text(weight: "bold", fill: white, size: 8pt)[Topic / Syllabus Area]],
  [#text(weight: "bold", fill: white, size: 8pt)[Final Answer (NESA Standard)]],

  [*1*], [Calculus --- Linear Substitution], [$1/6 (4x + 1)^(3/2) + C$],
  [*2*], [Calculus --- Increasing Functions], [$x <= -sqrt(3) quad "or" quad x >= sqrt(3) quad ((-infinity, -sqrt(3)] union [sqrt(3), infinity))$],
  [*3*], [Calculus --- Logarithmic Integration], [$1/3 ln(e^(3x) + 1) + C$],
  [*4a*], [Calculus --- Chain Rule], [$(3(sqrt(x) + 1)^2) / (2sqrt(x))$],
  [*4b*], [Calculus --- Reverse Chain Rule], [$1/3 (sqrt(x) + 1)^3 + C$],
  [*5*], [Sequences & Series --- AP], [*Day 43*],
  [*6a*], [Calculus --- Stationary Points], [*Local Max:* $(1, 7)$ $quad | quad$ *Local Min:* $(3, 3)$],
  [*6b*], [Calculus --- Point of Inflection], [*Point of Inflection:* $(2, 5)$],
  [*6c*], [Calculus --- Curve Sketching], [Smooth cubic through $(0, 3)$, max at $(1, 7)$, inflection at $(2, 5)$, min at $(3, 3)$],
  [*7*], [Calculus --- Tangents & Normals], [$x + 4y - (2 + 4 ln 3) = 0 quad (y = -1/4 x + 1/2 + ln 3)$],
  [*8*], [Trigonometry --- Quadratic Eqn], [$x = (2pi)/3, quad pi, quad (4pi)/3$],
  [*9*], [Functions --- Absolute Value], [$x = 2 quad "or" quad x = -5$],
  [*10*], [Calculus --- Product & Chain Rule], [$5 cos 5x tan(e^x) + e^x sin 5x sec^2(e^x)$],
  [*11*], [Functions --- Domain & Range], [*Domain:* $x >= 1 quad ([1, infinity)) quad | quad$ *Range:* $y >= 0 quad ([0, infinity))$],
  [*12i*], [Statistics --- Correlation], [$r approx 0.53$ (moderate positive linear correlation)],
  [*12ii*], [Statistics --- Regression Line], [*$W = 18x + 706$*],
  [*12iii*], [Statistics --- Validity], [No; extrapolation outside $[15, 68]$ is unreliable & unrealistic in reality],
  [*13*], [Differential Eqn --- Exponential], [*11 months*],
  [*14*], [Normal Distribution], [*$0.6449$* (or $64.49\%$) satisfying $P(-0.6 <= Z <= 1.4)$],
  [*15a*], [Optimization --- Total Length], [Shown: $l = 3x + 48/x$],
  [*15b*], [Optimization --- Minimum Length], [*$x = 4 "m"$*],
  [*15c*], [Optimization --- Minimum Cost], [*$\$228.00$*],
  [*16*], [Financial Maths --- Annuities], [*$\$2354.88$*]
)
