//! Synced tables shared by every native view: one Electric shape per table for the app's lifetime,
//! as the web's SyncProvider keeps its collections.

use std::sync::Arc;

use gpui_kit::*;

use crate::model::rows::{Approval, QueuedMessage, Session, Table};
use crate::net::Net;
use crate::net::shape::{self, ShapeUpdate};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TableId {
    Sessions,
    Approvals,
    Queued,
}

pub struct Store {
    net: Arc<Net>,
    sessions: Table,
    approvals: Table,
    queued: Table,
    _follows: Vec<Task<()>>,
}

/// The app-wide store, set once at startup.
pub struct GlobalStore(pub Entity<Store>);

impl Global for GlobalStore {}

impl Store {
    pub fn new(net: Arc<Net>, cx: &mut Context<Self>) -> Self {
        let follows = vec![
            Self::follow(&net, TableId::Sessions, "/v2/sessions", cx),
            Self::follow(&net, TableId::Approvals, "/v2/approvals", cx),
            Self::follow(&net, TableId::Queued, "/v2/queued-messages", cx),
        ];
        Self {
            net,
            sessions: Table::default(),
            approvals: Table::default(),
            queued: Table::default(),
            _follows: follows,
        }
    }

    pub fn global(cx: &App) -> Entity<Store> {
        cx.global::<GlobalStore>().0.clone()
    }

    pub fn net(&self) -> Arc<Net> {
        self.net.clone()
    }

    fn table_mut(&mut self, id: TableId) -> &mut Table {
        match id {
            TableId::Sessions => &mut self.sessions,
            TableId::Approvals => &mut self.approvals,
            TableId::Queued => &mut self.queued,
        }
    }

    fn follow(
        net: &Arc<Net>,
        id: TableId,
        route: &'static str,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        let receiver = shape::subscribe(net.clone(), route);
        cx.spawn(async move |this, cx| {
            while let Ok(batch) = receiver.recv().await {
                let applied = this.update(cx, |store, cx| {
                    let table = store.table_mut(id);
                    for update in batch {
                        match update {
                            ShapeUpdate::Reset => table.clear(),
                            ShapeUpdate::Ops(ops) => ops.into_iter().for_each(|op| table.apply(op)),
                            ShapeUpdate::UpToDate => table.set_ready(),
                        }
                    }
                    cx.notify();
                });
                if applied.is_err() {
                    break;
                }
            }
        })
    }

    /// Whether the sessions shape has caught up once, so a missing session really is missing.
    pub fn sessions_ready(&self) -> bool {
        self.sessions.is_ready()
    }

    pub fn session(&self, id: &str) -> Option<Session> {
        self.sessions
            .rows()
            .filter_map(Session::from_row)
            .find(|session| session.id == id)
    }

    /// Approvals the agent waits on, oldest first, as AskCard takes them.
    pub fn pending_approvals(&self, session_id: &str) -> Vec<Approval> {
        let mut approvals: Vec<Approval> = self
            .approvals
            .rows()
            .filter_map(Approval::from_row)
            .filter(|approval| {
                approval.session_id == session_id
                    && approval.status == Some(crate::model::transcript::ApprovalStatus::Pending)
            })
            .collect();
        approvals.sort_by_key(|approval| approval.created_at);
        approvals
    }

    pub fn queued_messages(&self, session_id: &str) -> Vec<QueuedMessage> {
        let mut messages: Vec<QueuedMessage> = self
            .queued
            .rows()
            .filter_map(QueuedMessage::from_row)
            .filter(|message| message.session_id == session_id && message.pending)
            .collect();
        messages.sort_by_key(|message| message.created_at);
        messages
    }
}
