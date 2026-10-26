const FAILURE_COPY = {
    certificateExpired: {
        reason: 'SSH certificate has expired.',
        summary: 'Certificate expired. Renew it and select the updated certificate.',
    },
    certificateMismatch: {
        reason: 'Certificate and private key do not match.',
        summary: 'Certificate and private key do not match. Select a matching pair.',
    },
    refused: {
        reason: 'Connection refused.',
        summary: 'Connection refused. Check the host, port and whether the SSH server is running.',
    },
    timeout: {
        reason: 'Connection timed out.',
        summary: 'Connection timed out. Check the network, firewall and selected adapter.',
    },
    authentication: {
        reason: 'Authentication failed.',
        summary: 'Authentication failed. Check the remote username and selected credential.',
    },
};

/** Recognize existing connection diagnostics once; raw server messages never become authored UI copy. */
function recognizedConnectionFailure(message: string): keyof typeof FAILURE_COPY | undefined {
    if (/SSH user certificate has expired/i.test(message)) {
        return 'certificateExpired';
    }
    if (/SSH user certificate does not match/i.test(message)) {
        return 'certificateMismatch';
    }
    if (/connection refused|actively refused|os error (?:10061|111|61)\b/i.test(message)) {
        return 'refused';
    }
    if (/timed out|timeout|os error 10060\b/i.test(message)) {
        return 'timeout';
    }
    if (/authentication failed|authentication rejected/i.test(message)) {
        return 'authentication';
    }
    return undefined;
}

/** Explain only recognizable failures; preserve the original message separately for diagnostics. */
export function connectionFailureSummary(message: string): string {
    const kind = recognizedConnectionFailure(message);
    return kind ? FAILURE_COPY[kind].summary : 'Could not verify this connection. Review the details below.';
}

/** Keep recovery cards concise without echoing an unknown failure or guessing its cause. */
export function connectionFailureReason(message = ''): string {
    const kind = recognizedConnectionFailure(message);
    return kind ? FAILURE_COPY[kind].reason : 'Could not connect to this host.';
}

/** Prefer a readable IPv4 address without hiding or changing the adapter's other addresses. */
export function orderedInterfaceAddresses(addresses: readonly string[]): string[] {
    return [...new Set(addresses)].sort((left, right) => Number(left.includes(':')) - Number(right.includes(':')));
}
