const messages = {
    auth_rejected: 'TypeSafe rejected the API key. Check that it is an active key from the TypeSafe console.',
    rate_limited: 'TypeSafe is rate limiting requests. Wait a moment, then try connecting again.',
    service_unavailable: 'TypeSafe is temporarily unavailable. Try again later.',
    network_error: 'Relay could not reach TypeSafe securely. Check your connection, then try again.',
    cancelled_or_timeout: 'The TypeSafe request was cancelled or timed out. Try connecting again.',
    invalid_catalog: 'TypeSafe returned an unsupported model catalog. The connection was not saved.',
    storage_failed: 'Relay could not save the credential in encrypted local storage. The connection is disabled.',
    request_expired: 'The secure connection request expired or its session changed. Start a new connection request.',
    invalid_key_format: 'Paste only the raw TypeSafe API key, without Bearer, quotes, or whitespace.',
    configuration_busy: 'Another TypeSafe configuration change is running. Wait for it to finish, then try again.',
    unknown: 'TypeSafe could not be connected. Try again; if it still fails, check Relay diagnostics.',
} as const;

export type TypeSafeErrorCode = keyof typeof messages;
/** Only locally defined messages may be displayed for a sensitive credential request. */
export function typeSafeErrorMessage(code: unknown): string | undefined {
    return typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code as TypeSafeErrorCode] : undefined;
}

const catalogMessages = {
    response_missing: 'The catalog response had no body.',
    response_too_large: 'The catalog response exceeded Relay’s size limit.',
    invalid_json: 'The catalog response was not valid UTF-8 JSON.',
    wrapper_shape: 'The catalog did not contain the expected models array.',
    models_empty: 'The catalog contained no available models.',
    model_count_limit: 'The catalog exceeded Relay’s model count limit.',
    model_entry_shape: 'A catalog model entry was not an object.',
    model_name_type: 'A catalog model name was missing or was not text.',
    model_name_limit: 'A catalog model name was empty or exceeded Relay’s length limit.',
    model_name_control: 'A catalog model name contained control characters.',
    model_name_sensitive: 'A catalog model name contained sensitive credential data.',
    duplicate_model_name: 'The catalog contained duplicate model names.',
} as const;

export type TypeSafeCatalogIssue = keyof typeof catalogMessages;
export function typeSafeCatalogIssueMessage(issue: unknown): string | undefined {
    return typeof issue === 'string' && Object.hasOwn(catalogMessages, issue) ? catalogMessages[issue as TypeSafeCatalogIssue] : undefined;
}
