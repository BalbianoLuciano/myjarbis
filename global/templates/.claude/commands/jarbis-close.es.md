# /jarbis-close — Cerrar la sesión y dejarla lista para la próxima

El user escribió esto porque terminaron de trabajar. **El comando ES la
confirmación**: no preguntes "¿seguro que querés cerrar?". Tu trabajo es
dejar la memoria en un estado que la próxima sesión pueda usar, y después
mostrarle en pocas líneas qué escribiste para que lo corrija si está mal.

Existe porque el hook de `SessionEnd` ya cierra la sesión solo si te
olvidás — pero escribe un resumen sintético (`[auto] ... 0 observations
saved` + la lista de commits). Eso es un registro de actividad, no una
bitácora: dice que hubo tres commits, no dice qué hacer mañana. Esa
diferencia es todo el valor de este comando.

---

## Orden (importa)

### 0. Antes de escribir nada, mirá el estado real

Corré `git status --short`. Si el proyecto tiene tests y los corriste en
esta sesión, decí si están verdes; si **no** los corriste, decí eso — no
lo supongas.

Si hay archivos sin commitear o tests rojos: **decilo primero y preguntá
si cierro igual.** Nunca cierres en silencio arriba de trabajo a medio
hacer; el próximo arranque no tiene forma de enterarse.

### 1. Observaciones pendientes

Por cada decisión, gotcha o progreso de esta sesión que todavía no
guardaste: `save_observation` con `kind` correcto, `content` en orden
WHY → WHAT → HOW, y `files`.

Para lo que tiene un **valor actual** en lugar de una historia (el estado
de un tema, la forma en que se hace algo), llamá `suggest_topic_key`
primero y reusá la clave que vuelva: así la nota se actualiza en lugar de
sumar una rival. Si la nota es un evento puntual, va sin `topic_key`.

No guardes una nota por cada archivo tocado. Guardá lo que le ahorraría
una hora a quien abra esto en tres semanas.

### 2. La bitácora viva — `set_project_state`

Es lo primero que lee la próxima sesión, y **reemplaza** el contenido
anterior: escribí la foto completa, no un delta.

Que incluya, en este orden:
- dónde está la cosa hoy;
- qué está **verificado** y qué no (si corriste la suite, el número; si
  no la corriste, decilo);
- el próximo paso concreto, y los que vienen después si los hay;
- lo ya medido y cerrado que no hay que volver a discutir.

### 3. `end_session`

Dos campos, y **los redactás vos** a partir de lo que pasó en la sesión.
No le pidas al user que te los dicte — pedírselos es exactamente lo que
este comando viene a evitar.

- `summary` — 1 a 3 bullets de retrospectiva. Sin celebración.
- `next_session` — el "Retomar aquí". Una **acción**, no un diario:
  verbo + path/branch/PR + comando si hay que correr algo. Si quedó algo
  sin verificar, va acá; omitirlo es lo que hace que la próxima sesión
  crea que estaba hecho. ≤ 10 líneas.

### 4. Recapitulá en corto

Mostrale: qué notas guardaste (títulos), el `next_session` textual, y
una línea ofreciéndote a reescribir cualquiera de los dos si no le cierra.

---

## Reglas

- **No inventes progreso.** Si la sesión no avanzó, el resumen dice que no
  avanzó. Un resumen optimista es peor que el sintético, porque se le cree.
- **No commitees ni pushees** como parte de cerrar, salvo que el user lo
  pida. Cerrar es un acto de memoria, no de git.
- **Si no hay sesión abierta** (ya la cerró un hook, o nunca se abrió):
  decilo, y ofrecé igual escribir `set_project_state`, que es la parte que
  sobrevive de todas formas.
- **Si el user pidió cerrar para cambiar de módulo**, no uses este
  comando a secas: cerrá y arrancá la sesión nueva en el módulo destino,
  confirmando el destino primero.
- Si la sesión fue larga y hay riesgo de que te falte contexto de la
  primera mitad, decilo en el resumen en lugar de rellenar.
