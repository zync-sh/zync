use bytes::Bytes;
use tokio::sync::mpsc;

pub struct Stream {
    req_tx: Option<mpsc::Sender<Bytes>>,
    extra_tx: mpsc::Sender<Bytes>,
    cancel: tokio::sync::watch::Sender<bool>,
}

pub struct StreamReaders {
    pub req_rx: mpsc::Receiver<Bytes>,
    pub extra_rx: mpsc::Receiver<Bytes>,
    pub cancel_rx: tokio::sync::watch::Receiver<bool>,
}

impl Stream {
    pub fn new(_id: i64) -> (Self, StreamReaders) {
        let (req_tx, req_rx) = mpsc::channel(32);
        let (extra_tx, extra_rx) = mpsc::channel(32);
        let (cancel, cancel_rx) = tokio::sync::watch::channel(false);
        (
            Self {
                req_tx: Some(req_tx),
                extra_tx,
                cancel,
            },
            StreamReaders {
                req_rx,
                extra_rx,
                cancel_rx,
            },
        )
    }

    /// Clone the active uplink sender so callers can release locks before awaiting.
    pub fn data_sender(&self) -> mpsc::Sender<Bytes> {
        self.req_tx.clone().unwrap_or_else(|| self.extra_tx.clone())
    }

    /// First close completes the HTTP request body. Later close aborts the stream.
    pub fn finish_request_body(&mut self) -> bool {
        if self.req_tx.take().is_some() {
            true
        } else {
            self.cancel();
            false
        }
    }

    pub fn cancel(&self) {
        let _ = self.cancel.send(true);
    }
}

pub fn is_cancelled(rx: &tokio::sync::watch::Receiver<bool>) -> bool {
    *rx.borrow()
}
