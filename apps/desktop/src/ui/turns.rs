//! Rows of the native thread, ported from apps/web/src/minimalist/components/Transcript.tsx and Steps.tsx.

use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::clipboard::Clipboard;
use gpui_kit::component::text::{TextView, TextViewState};
use gpui_kit::component::{ActiveTheme as _, Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::Value;

use crate::model::format::{
    artifact_name, first_line, format_clock, format_duration, plural, split_attachments, truncate,
};
use crate::model::tools::{
    FileEdits, StepIcon, TodoStatus, common_dir, is_edit_tool, latest_todos, summarize_step,
    text_field, turn_file_writes,
};
use crate::model::transcript::{
    AgentTurn, ApprovalStatus, Step, StepGroup, ToolStep, Turn, group_steps, normalize_tool_name,
    read_denial,
};
use crate::ui::thread::{ThreadEvent, ThreadView};
use crate::ui::web::WebActions;

/// One row of the virtual list.
#[derive(Clone, Debug, PartialEq)]
pub enum ThreadRow {
    Turn {
        /// Shared with the thread's turn list: rebuilding rows doesn't copy the transcript.
        turn: Rc<Turn>,
        live: bool,
        /// A user turn's position among user turns, or an agent turn's among edits cards.
        ordinal: Option<usize>,
    },
    /// Text the agent is streaming, before it is saved as an event.
    Streaming,
    /// The agent was asked to run and has produced nothing yet.
    Starting,
}

impl ThreadRow {
    pub fn key(&self) -> String {
        match self {
            ThreadRow::Turn { turn, .. } => turn.id().to_owned(),
            ThreadRow::Streaming => "streaming".into(),
            ThreadRow::Starting => "starting".into(),
        }
    }
}

/// What every row renderer reads besides the row itself.
#[derive(Clone)]
pub struct RowContext {
    pub thread: WeakEntity<ThreadView>,
    /// Open (true) or closed (false) as the reader set it, per turn or step id.
    pub toggled: Rc<HashMap<String, bool>>,
    pub streaming: Entity<TextViewState>,
    pub now_ms: i64,
    /// The window rem size, in the ids of markdown views: they cache their layout per id, so a
    /// zoom change needs new ones.
    pub rem: u32,
    /// Fork and Review, when the page offers them.
    pub actions: WebActions,
}

impl RowContext {
    fn is_open(&self, id: &str, default_open: bool) -> bool {
        self.toggled.get(id).copied().unwrap_or(default_open)
    }

    /// Flip a row the reader sees as `open_now`, and keep that choice when its default changes
    /// (a live turn finishing, say).
    fn toggle_handler(
        &self,
        id: &str,
        open_now: bool,
    ) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        let thread = self.thread.clone();
        let id = id.to_owned();
        move |_, _, cx| {
            let _ = thread.update(cx, |thread, cx| thread.set_open(&id, !open_now, cx));
        }
    }
}

/// A CSS pixel length from minimalist/styles.css, in rems so app zoom scales it with the text
/// (gpui-kit sets the rem to the theme font size, 16px at 100%).
fn css(value: f32) -> Rems {
    rems(value / 16.)
}

/// `.col` in minimalist/styles.css: 720px wide, at most the pane width less 64px.
const COLUMN_WIDTH: f32 = 720.;

/// Center a row's content in the reading column.
pub fn column(content: impl IntoElement) -> Div {
    div()
        .w_full()
        .flex()
        .justify_center()
        .px(css(32.))
        .child(div().w_full().max_w(css(COLUMN_WIDTH)).child(content))
}

/// `.turn-actions.hover-reveal`: copy and time, shown while the pointer is over the turn.
fn turn_actions(group: SharedString, id: String, text: String, stamp: String, cx: &App) -> Div {
    h_flex()
        .gap(css(12.))
        .mt(css(4.))
        .mb(css(8.))
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .opacity(0.)
        .group_hover(group, |style| style.opacity(1.))
        .child(Clipboard::new(SharedString::from(format!("copy-{id}"))).value(text))
        .child(stamp)
}

pub fn render_row(row: &ThreadRow, context: &RowContext, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let body: AnyElement = match row {
        ThreadRow::Turn {
            turn,
            live,
            ordinal,
        } => match turn.as_ref() {
            Turn::User {
                id,
                text,
                author,
                at,
            } => {
                // `.turn-user` > `.msg` > `.bubble`: the message as typed, not rendered as markdown.
                let group = SharedString::from(format!("turn-{id}"));
                // `MessageBody`: uploads show as files above the bubble, the rest as typed.
                let (body, files) = split_attachments(text);
                let chips = files.iter().enumerate().map(|(index, file)| {
                    let name = artifact_name(file);
                    let (thread, turn_id) = (context.thread.clone(), id.clone());
                    h_flex()
                        .id(SharedString::from(format!("file-{id}-{index}")))
                        .gap(css(6.))
                        .px(css(10.))
                        .py(css(5.))
                        .rounded(css(8.))
                        .border_1()
                        .border_color(theme.border)
                        .text_size(css(12.5))
                        .cursor_pointer()
                        .hover(|style| style.bg(theme.secondary))
                        .on_click(move |_, _, cx| {
                            let _ = thread.update(cx, |thread, cx| {
                                thread.open_attachment(&turn_id, index, cx)
                            });
                        })
                        .child(Icon::new(IconName::FileText).xsmall())
                        .child(name)
                });
                let stamp = match author {
                    Some(author) => format!("{author} · {}", format_clock(*at)),
                    None => format_clock(*at),
                };
                h_flex()
                    .group(group.clone())
                    .w_full()
                    .justify_end()
                    .pt(css(22.))
                    .pb(css(18.))
                    .child(
                        v_flex()
                            .max_w(relative(0.76))
                            .items_end()
                            .gap(css(6.))
                            .when(!files.is_empty(), |this| {
                                this.child(
                                    h_flex()
                                        .flex_wrap()
                                        .justify_end()
                                        .gap(css(6.))
                                        .children(chips),
                                )
                            })
                            .when(!body.is_empty(), |this| {
                                this.child(
                                    div()
                                        .id(SharedString::from(format!("user-{id}")))
                                        .px(css(14.))
                                        .py(css(9.))
                                        .rounded(css(16.))
                                        .bg(theme.secondary)
                                        .text_size(css(13.))
                                        .line_height(relative(1.5))
                                        .whitespace_normal()
                                        .child(body.clone()),
                                )
                            })
                            .child(
                                turn_actions(group, id.clone(), text.clone(), stamp, cx)
                                    // Every user turn after the first can be forked from.
                                    .when_some(
                                        ordinal
                                            .filter(|turn| *turn > 0 && context.actions.forkable),
                                        |this, turn| {
                                            let thread = context.thread.clone();
                                            this.child(
                                                Button::new(SharedString::from(format!(
                                                    "fork-{id}"
                                                )))
                                                .ghost()
                                                .xsmall()
                                                .icon(gpui_kit::assets::IconName::GitFork)
                                                .tooltip("Fork from this message")
                                                .on_click(move |_, _, cx| {
                                                    let _ = thread.update(cx, |_, cx| {
                                                        cx.emit(ThreadEvent::Fork { turn })
                                                    });
                                                }),
                                            )
                                        },
                                    ),
                            ),
                    )
                    .into_any_element()
            }
            Turn::Compaction { .. } => {
                divider("Earlier messages summarized to save context", cx).into_any_element()
            }
            Turn::Notice { text, .. } => divider(text.clone(), cx).into_any_element(),
            Turn::Agent(turn) => agent_turn(turn, *live, *ordinal, context, cx).into_any_element(),
        },
        ThreadRow::Streaming => div()
            .py_2()
            .child(
                TextView::new(&context.streaming)
                    .selectable(true)
                    .stream_fade(true),
            )
            .into_any_element(),
        ThreadRow::Starting => h_flex()
            .py_2()
            .gap_2()
            .text_sm()
            .text_color(theme.muted_foreground)
            .child(Icon::new(IconName::Loader).small())
            .child("Starting…")
            .into_any_element(),
    };
    column(body).into_any_element()
}

fn divider(text: impl Into<SharedString>, cx: &App) -> impl IntoElement {
    h_flex()
        .w_full()
        .py_3()
        .gap_3()
        .items_center()
        .text_xs()
        .text_color(cx.theme().muted_foreground)
        .child(div().flex_1().h(px(1.)).bg(cx.theme().border))
        .child(text.into())
        .child(div().flex_1().h(px(1.)).bg(cx.theme().border))
}

fn agent_turn(
    turn: &AgentTurn,
    live: bool,
    card: Option<usize>,
    context: &RowContext,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme();
    let waiting = turn.steps.iter().any(|step| matches!(step, Step::Tool(tool) if tool.approval_status == Some(ApprovalStatus::Pending)));
    let open = context.is_open(&turn.id, live || waiting);
    let elapsed = if live { context.now_ms } else { turn.ended_at } - turn.started_at;
    let duration = if elapsed < 1000 {
        "a moment".to_owned()
    } else {
        format_duration(elapsed)
    };
    let todos = latest_todos(&turn.steps);
    v_flex()
        .group(SharedString::from(format!("turn-{}", turn.id)))
        .w_full()
        .py_2()
        .when(!turn.steps.is_empty(), |this| {
            this.child(
                // `.worked`: 12.5px, with a rule under it.
                h_flex()
                    .id(SharedString::from(format!("worked-{}", turn.id)))
                    .w_full()
                    .gap_1()
                    .pb(css(8.))
                    .mb(css(10.))
                    .border_b_1()
                    .border_color(theme.border)
                    .text_size(css(12.5))
                    .text_color(theme.muted_foreground)
                    .cursor_default()
                    .hover(|style| style.text_color(theme.foreground))
                    .on_click(context.toggle_handler(&turn.id, open))
                    .child(if live {
                        format!("Working for {duration}")
                    } else {
                        format!("Worked for {duration}")
                    })
                    .child(
                        Icon::new(if open {
                            IconName::ChevronDown
                        } else {
                            IconName::ChevronRight
                        })
                        .xsmall(),
                    ),
            )
        })
        .when(open, |this| {
            this.child(
                v_flex()
                    .gap_1()
                    .pl_1()
                    .children(step_list(&turn.steps, context, cx)),
            )
        })
        .when(!todos.is_empty() && (live || !open), |this| {
            let done = todos
                .iter()
                .filter(|todo| todo.status == TodoStatus::Completed)
                .count();
            this.child(
                v_flex()
                    .gap_1()
                    .p_3()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(theme.border)
                    .text_sm()
                    .child(
                        div()
                            .text_color(theme.muted_foreground)
                            .child(format!("Plan · {done} of {} done", todos.len())),
                    )
                    .children(todos.iter().map(|todo| {
                        h_flex()
                            .gap_2()
                            .child(
                                Icon::new(match todo.status {
                                    TodoStatus::Completed => IconName::CircleCheck,
                                    TodoStatus::InProgress => IconName::Loader,
                                    TodoStatus::Pending => IconName::Square,
                                })
                                .xsmall(),
                            )
                            .child(
                                div()
                                    .when(todo.status == TodoStatus::Completed, |this| {
                                        this.line_through().text_color(theme.muted_foreground)
                                    })
                                    .child(todo.content.clone()),
                            )
                    })),
            )
        })
        .when_some(turn.answer.clone(), |this, answer| {
            // `.prose`: 13.5px, line height 1.6.
            this.child(
                div().text_size(css(13.5)).line_height(relative(1.6)).child(
                    TextView::markdown(
                        SharedString::from(format!("answer-{}-{}", turn.id, context.rem)),
                        answer,
                    )
                    .selectable(true),
                ),
            )
        })
        .when_some(card, |this, card| {
            this.child(edits_summary(
                &turn_file_writes(&turn.steps),
                card,
                context,
                cx,
            ))
        })
        .when_some(turn.answer.clone().filter(|_| !live), |this, answer| {
            this.child(turn_actions(
                SharedString::from(format!("turn-{}", turn.id)),
                turn.id.clone(),
                answer,
                format_clock(turn.ended_at),
                cx,
            ))
        })
}

/// Transcript.tsx `EditsSummary`: what a turn changed, totals then each file. Its Review actions
/// open the page's own edits card at the same place.
fn edits_summary(files: &[FileEdits], card: usize, context: &RowContext, cx: &App) -> AnyElement {
    const LISTED_FILES: usize = 4;
    let theme = cx.theme();
    let (added, removed) = files
        .iter()
        .fold((0, 0), |(a, r), file| (a + file.added, r + file.removed));
    // Past the limit the last row counts the rest; a single leftover gets its own row.
    let listed = if files.len() > LISTED_FILES + 1 {
        LISTED_FILES
    } else {
        files.len()
    };
    let only = (files.len() == 1).then(|| files[0].path.clone());
    let root = common_dir(
        &files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
    );
    let reviewable = context.actions.reviewable;
    let review = move |path: Option<String>, thread: WeakEntity<ThreadView>| {
        move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
            let path = path.clone();
            let _ = thread.update(cx, |_, cx| cx.emit(ThreadEvent::Review { card, path }));
        }
    };
    let counts = |added: usize, removed: usize| {
        h_flex()
            .gap(css(6.))
            .child(div().text_color(theme.green).child(format!("+{added}")))
            .child(div().text_color(theme.red).child(format!("−{removed}")))
    };
    let title = match &only {
        Some(path) => format!("Edited {}", path.rsplit('/').next().unwrap_or(path)),
        None => format!("Edited {}", plural(files.len(), "file")),
    };
    v_flex()
        .w_full()
        .my(css(8.))
        .rounded(css(10.))
        .border_1()
        .border_color(theme.border)
        .text_size(css(12.5))
        .child(
            h_flex()
                .gap(css(8.))
                .px(css(12.))
                .py(css(8.))
                .child(Icon::new(IconName::File).xsmall())
                .child(
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .text_ellipsis()
                        .child(title),
                )
                .child(counts(added, removed))
                .child(div().flex_1())
                .when(reviewable, |this| {
                    this.child(
                        Button::new(SharedString::from(format!("review-{card}")))
                            .ghost()
                            .xsmall()
                            .label("Review")
                            .on_click(review(only.clone(), context.thread.clone())),
                    )
                }),
        )
        .children(
            files
                .iter()
                .take(if only.is_some() { 0 } else { listed })
                .enumerate()
                .map(|(index, file)| {
                    let relative = file
                        .path
                        .strip_prefix(&root)
                        .unwrap_or(&file.path)
                        .to_owned();
                    let (dir, name) = match relative.rsplit_once('/') {
                        Some((dir, name)) => (Some(dir.to_owned()), name.to_owned()),
                        None => (None, relative),
                    };
                    h_flex()
                        .id(SharedString::from(format!("edit-{card}-{index}")))
                        .gap(css(8.))
                        .px(css(12.))
                        .py(css(5.))
                        .border_t_1()
                        .border_color(theme.border)
                        .when(reviewable, |this| {
                            this.cursor_pointer()
                                .hover(|style| style.bg(theme.secondary))
                                .on_click(review(Some(file.path.clone()), context.thread.clone()))
                        })
                        .child(
                            h_flex()
                                .flex_1()
                                .min_w_0()
                                .gap(css(6.))
                                .child(name)
                                .when_some(dir, |this, dir| {
                                    this.child(div().text_color(theme.muted_foreground).child(dir))
                                }),
                        )
                        .child(counts(file.added, file.removed))
                }),
        )
        .when(listed < files.len(), |this| {
            this.child(
                div()
                    .id(SharedString::from(format!("edit-{card}-more")))
                    .px(css(12.))
                    .py(css(5.))
                    .border_t_1()
                    .border_color(theme.border)
                    .text_color(theme.muted_foreground)
                    .when(reviewable, |this| {
                        this.cursor_pointer()
                            .on_click(review(None, context.thread.clone()))
                    })
                    .child(plural(files.len() - listed, "more file")),
            )
        })
        .into_any_element()
}

fn step_list(steps: &[Step], context: &RowContext, cx: &App) -> Vec<AnyElement> {
    group_steps(steps)
        .into_iter()
        .map(|group| match group {
            StepGroup::Single(step) => step_row(step, context, cx),
            StepGroup::Explore { id, steps } => {
                let open = context.is_open(id, false);
                let reads = steps
                    .iter()
                    .filter(|step| matches!(step, Step::Tool(tool) if normalize_tool_name(&tool.name) == "read"))
                    .count();
                let searches = steps.len() - reads;
                let facts = [(reads > 0).then(|| format!("Read {reads}")), (searches > 0).then(|| format!("Searched {searches}"))]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(", ");
                v_flex()
                    .child(
                        step_line(id, cx)
                            .on_click(context.toggle_handler(id, open))
                            .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).xsmall())
                            .child(format!("Explored {}", plural(steps.len(), "item")))
                            .child(div().text_color(cx.theme().muted_foreground).child(format!("· {facts}"))),
                    )
                    .when(open, |this| {
                        this.child(v_flex().pl_4().children(steps.iter().map(|step| step_row(step, context, cx))))
                    })
                    .into_any_element()
            }
        })
        .collect()
}

fn step_line(id: &str, cx: &App) -> Stateful<Div> {
    h_flex()
        .id(SharedString::from(format!("step-{id}")))
        .gap_2()
        .py(css(2.))
        .text_sm()
        .min_w_0()
        .cursor_default()
        .hover(|style| style.bg(cx.theme().muted))
        .rounded(cx.theme().radius)
}

fn step_icon(icon: StepIcon) -> IconName {
    match icon {
        StepIcon::File => IconName::FileText,
        StepIcon::Terminal => IconName::SquareTerminal,
        StepIcon::Search => IconName::Search,
        StepIcon::Bot => IconName::Bot,
        StepIcon::Globe => IconName::Globe,
        StepIcon::Todo => IconName::CircleCheck,
        StepIcon::Plug => IconName::Network,
        StepIcon::List => IconName::BookOpen,
        StepIcon::Message => IconName::Inbox,
        StepIcon::Tool => IconName::Settings2,
    }
}

fn mono(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .font_family(cx.theme().mono_font_family.clone())
        .text_ellipsis()
        .overflow_hidden()
        .whitespace_nowrap()
        .child(text.into())
}

fn step_row(step: &Step, context: &RowContext, cx: &App) -> AnyElement {
    let theme = cx.theme();
    match step {
        Step::Thinking { id, text } => {
            let open = context.is_open(id, false);
            div()
                .id(SharedString::from(format!("think-{id}")))
                .text_sm()
                .italic()
                .text_color(theme.muted_foreground)
                .cursor_default()
                .on_click(context.toggle_handler(id, open))
                .child(if open {
                    text.clone()
                } else {
                    first_line(text, 140)
                })
                .into_any_element()
        }
        Step::Commentary { id, text } => div()
            .py_1()
            .child(
                TextView::markdown(
                    SharedString::from(format!("commentary-{id}-{}", context.rem)),
                    text.clone(),
                )
                .selectable(true),
            )
            .into_any_element(),
        Step::Skill { id, name, text } => {
            let open = context.is_open(id, false);
            v_flex()
                .child(
                    step_line(id, cx)
                        .on_click(context.toggle_handler(id, open))
                        .child(Icon::new(IconName::BookOpen).xsmall())
                        .child("Loaded skill")
                        .when_some(name.clone(), |this, name| this.child(mono(name, cx))),
                )
                .when(open, |this| {
                    this.child(skill_card(id, text, context.rem, cx))
                })
                .into_any_element()
        }
        Step::Tool(tool) => tool_row(tool, context, cx),
    }
}

fn skill_card(id: &str, text: &str, rem: u32, cx: &App) -> impl IntoElement {
    // Claude Code's first line only names the skill's directory; the row already names the skill.
    let body = match text.strip_prefix("Base directory for this skill:") {
        Some(rest) => rest
            .split_once('\n')
            .map(|(_, body)| body.trim_start())
            .unwrap_or("")
            .to_owned(),
        None => text.to_owned(),
    };
    div()
        .ml_6()
        .p_3()
        .rounded(cx.theme().radius)
        .border_1()
        .border_color(cx.theme().border)
        .child(
            TextView::markdown(SharedString::from(format!("skill-{id}-{rem}")), body)
                .selectable(true),
        )
}

fn tool_row(step: &ToolStep, context: &RowContext, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let name = normalize_tool_name(&step.name);
    if name == "todowrite" {
        return div().into_any_element();
    }
    let summary = summarize_step(step);
    let running = step.ended_at.is_none() && step.approval_status != Some(ApprovalStatus::Pending);
    let denied = step.approval_status == Some(ApprovalStatus::Denied);
    let feedback = if denied {
        read_denial(step.result.as_deref()).flatten()
    } else {
        None
    };
    let is_agent = name == "task" || name == "agent";
    let open = context.is_open(&step.id, false);
    let muted = theme.muted_foreground;
    v_flex()
        .min_w_0()
        .child(
            step_line(&step.id, cx)
                .on_click(context.toggle_handler(&step.id, open))
                .child(
                    Icon::new(if running {
                        IconName::Loader
                    } else {
                        step_icon(summary.icon)
                    })
                    .xsmall()
                    .text_color(muted),
                )
                .child(
                    div()
                        .flex_none()
                        .when(is_agent, |this| this.font_weight(FontWeight::SEMIBOLD))
                        .child(summary.verb.clone()),
                )
                .when_some(summary.target.clone(), |this, target| {
                    this.child(mono(target, cx).min_w_0())
                })
                .when_some(summary.meta.clone(), |this, meta| {
                    if is_edit_tool(&step.name) {
                        let (added, removed) = meta.split_once(' ').unwrap_or((meta.as_str(), ""));
                        this.child(
                            div()
                                .flex_none()
                                .text_color(theme.success)
                                .child(added.to_owned()),
                        )
                        .child(
                            div()
                                .flex_none()
                                .text_color(theme.danger)
                                .child(removed.to_owned()),
                        )
                    } else {
                        this.child(
                            div()
                                .flex_none()
                                .text_color(muted)
                                .child(format!("· {meta}")),
                        )
                    }
                })
                .when(
                    step.approval_status == Some(ApprovalStatus::Pending),
                    |this| {
                        this.child(
                            div()
                                .flex_none()
                                .text_color(muted)
                                .child("· Waiting for you"),
                        )
                    },
                )
                .when(denied, |this| {
                    this.child(div().flex_none().text_color(theme.danger).child("· Denied"))
                })
                .when(step.is_error && !denied, |this| {
                    this.child(div().flex_none().text_color(theme.danger).child("· Failed"))
                })
                .when_some(
                    step.ended_at.filter(|_| !is_agent && !denied),
                    |this, ended| {
                        this.child(
                            div()
                                .flex_none()
                                .text_color(muted)
                                .child(format!("· {}", format_duration(ended - step.started_at))),
                        )
                    },
                ),
        )
        .when_some(feedback, |this, feedback| {
            this.child(div().pl_6().text_sm().text_color(muted).child(feedback))
        })
        .when(open, |this| this.child(step_detail(step, context, cx)))
        .into_any_element()
}

fn code_block(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .w_full()
        .p_2()
        .rounded(cx.theme().radius)
        .bg(cx.theme().muted)
        .font_family(cx.theme().mono_font_family.clone())
        .text_xs()
        .whitespace_normal()
        .child(text.into())
}

fn step_detail(step: &ToolStep, context: &RowContext, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let name = normalize_tool_name(&step.name);
    let detail = v_flex().ml_6().my_1().gap_1();
    if name == "bash" {
        let command = text_field(&step.input, &["command"]);
        let description = text_field(&step.input, &["description"]);
        let output = match (&step.result, step.ended_at) {
            (Some(result), _) => truncate(result, 8000),
            (None, Some(_)) => "No output".into(),
            (None, None) => String::new(),
        };
        let status = if step.ended_at.is_none() {
            "Running"
        } else if step.is_error {
            "Failed"
        } else {
            "Success"
        };
        return detail
            .child(div().text_xs().text_color(theme.muted_foreground).child(
                if description.is_empty() {
                    "Shell".to_owned()
                } else {
                    format!("Shell · {description}")
                },
            ))
            .child(code_block(format!("$ {command}\n{output}"), cx))
            .child(
                div()
                    .text_xs()
                    .text_color(if step.is_error {
                        theme.danger
                    } else {
                        theme.muted_foreground
                    })
                    .child(status),
            )
            .into_any_element();
    }
    if name == "skill"
        && let Some(result) = step
            .result
            .as_deref()
            .filter(|r| crate::model::transcript::is_synthetic_skill_prompt(Some(r)))
    {
        return skill_card(&step.id, result, context.rem, cx).into_any_element();
    }
    if is_edit_tool(&step.name) {
        return diff_card(step, cx).into_any_element();
    }
    if name == "task" || name == "agent" {
        return detail
            .when(step.children.is_empty(), |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child("No steps yet"),
                )
            })
            .children(step_list(&step.children, context, cx))
            .when_some(step.result.clone(), |this, result| {
                this.child(
                    TextView::markdown(
                        SharedString::from(format!("agent-result-{}-{}", step.id, context.rem)),
                        truncate(&result, 4000),
                    )
                    .selectable(true),
                )
            })
            .into_any_element();
    }
    detail
        .child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child("Input"),
        )
        .child(code_block(
            serde_json::to_string_pretty(&Value::Object(step.input.clone())).unwrap_or_default(),
            cx,
        ))
        .when_some(step.result.clone(), |this, result| {
            this.child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("Result"),
            )
            .child(code_block(truncate(&result, 6000), cx))
        })
        .into_any_element()
}

/// Old lines in red, new lines in green, as Steps.tsx DiffCard shows an edit.
pub fn diff_card(step: &ToolStep, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let input = &step.input;
    let edits: Vec<(String, String)> = match (
        normalize_tool_name(&step.name).as_str(),
        input.get("edits").and_then(Value::as_array),
    ) {
        ("multiedit", Some(edits)) => edits
            .iter()
            .filter_map(Value::as_object)
            .map(|edit| {
                (
                    text_field(edit, &["old_string"]),
                    text_field(edit, &["new_string"]),
                )
            })
            .collect(),
        _ => vec![(
            text_field(input, &["old_string"]),
            text_field(input, &["new_string", "content"]),
        )],
    };
    let line = |text: &str, added: bool| {
        div()
            .w_full()
            .px_2()
            .bg(if added {
                theme.success.opacity(0.12)
            } else {
                theme.danger.opacity(0.12)
            })
            .child(text.to_owned())
    };
    v_flex()
        .ml_6()
        .my_1()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .overflow_hidden()
        .font_family(theme.mono_font_family.clone())
        .text_xs()
        .child(
            div()
                .px_2()
                .py_1()
                .text_color(theme.muted_foreground)
                .child(text_field(input, &["file_path", "path"])),
        )
        .children(edits.iter().flat_map(|(old, next)| {
            let removed: Vec<_> = if old.is_empty() {
                Vec::new()
            } else {
                old.split('\n').map(|l| line(l, false)).collect()
            };
            removed
                .into_iter()
                .chain(next.split('\n').map(|l| line(l, true)))
                .collect::<Vec<_>>()
        }))
}
