// PN532 over HSU (UART2). Polled from loop(); a hung or missing reader is retried with
// back-off and never stops the box (fail-open and the offline timer don't depend on it).
#pragma once
#include <string>

void readerBegin();
/** Poll every ~150 ms. Returns the UID on the reader (uppercase hex) or "" for none. */
std::string readerPoll(uint64_t mono_ms);
bool readerOk();
