use futures_util::{stream, Stream, StreamExt};
use std::future::Future;

/// Admit only the active window, preserving source order and applying consumer backpressure.
pub(super) fn read_window<I, F, Fut>(
    items: I,
    concurrency: usize,
    operation: F,
) -> impl Stream<Item = Fut::Output>
where
    I: IntoIterator,
    F: FnMut(I::Item) -> Fut,
    Fut: Future,
{
    assert!(
        concurrency > 0,
        "a work window must admit at least one operation"
    );
    stream::iter(items).map(operation).buffered(concurrency)
}

/// Stop admission on the first failed write and drain admitted mutations before returning it.
pub(super) async fn write_window<I, F, Fut, T, E>(
    items: I,
    concurrency: usize,
    mut operation: F,
) -> Result<Vec<T>, E>
where
    I: IntoIterator,
    F: FnMut(I::Item) -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    assert!(
        concurrency > 0,
        "a work window must admit at least one operation"
    );
    let mut remaining = items.into_iter();
    let mut active = futures_util::stream::FuturesUnordered::new();
    let mut results = Vec::new();
    let mut error = None;
    for item in remaining.by_ref().take(concurrency) {
        active.push(operation(item));
    }
    while let Some(result) = active.next().await {
        match result {
            Ok(value) => results.push(value),
            Err(failure) => {
                if error.is_none() {
                    error = Some(failure);
                }
            }
        }
        if error.is_none() {
            if let Some(item) = remaining.next() {
                active.push(operation(item));
            }
        }
    }
    match error {
        Some(error) => Err(error),
        None => Ok(results),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn paused_consumption_never_admits_the_remaining_collection() {
        let started = Arc::new(AtomicUsize::new(0));
        let calls = started.clone();
        let output = read_window(0..1000, 4, move |value| {
            calls.fetch_add(1, Ordering::SeqCst);
            async move { value }
        });
        futures_util::pin_mut!(output);
        output.next().await.unwrap();
        assert_eq!(started.load(Ordering::SeqCst), 4);
        tokio::task::yield_now().await;
        assert_eq!(
            started.load(Ordering::SeqCst),
            4,
            "idle consumers must apply backpressure"
        );
        let mut completed = 1;
        while output.next().await.is_some() {
            completed += 1;
        }
        assert_eq!(completed, 1000);
    }

    #[tokio::test]
    async fn failed_writes_stop_admission_but_drain_inflight_operations() {
        let started = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let calls = started.clone();
        let done = finished.clone();
        let result = write_window(0..100, 4, move |value| {
            calls.fetch_add(1, Ordering::SeqCst);
            let done = done.clone();
            async move {
                if value != 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                done.fetch_add(1, Ordering::SeqCst);
                if value == 0 {
                    Err("fixture failure")
                } else {
                    Ok(value)
                }
            }
        })
        .await;
        assert_eq!(result, Err("fixture failure"));
        assert_eq!(started.load(Ordering::SeqCst), 4);
        assert_eq!(finished.load(Ordering::SeqCst), 4);
    }
}
