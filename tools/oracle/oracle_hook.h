/* Force-included into every translation unit so Musashi's core sees the
 * prototype for the instruction hook it has been told to call. */
#ifndef ORACLE_HOOK_H
#define ORACLE_HOOK_H
void oracle_instr_hook(unsigned int pc);
#endif
