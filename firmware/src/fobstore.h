// The cached fobs list in flash (LittleFS on the "fobs" partition), so it survives a power cut.
#pragma once
#include <string>

bool fobstoreBegin();
/** False if there's no stored list. */
bool fobstoreLoad(std::string& out);
/** Writes only if it changed (the retained list arrives again on every reconnect). */
bool fobstoreSave(const std::string& json);
void fobstoreErase();
