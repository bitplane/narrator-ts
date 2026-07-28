# Builds liboracle.so — Musashi plus the shim, driven from Python by ctypes.
#
# The instruction hook is switched on with -D rather than by patching
# vendor/musashi, so a re-fetch never silently drops it. Musashi guards every
# option in m68kconf.h with #ifndef precisely so this works.

ROOT    := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
MUSASHI := $(ROOT)/vendor/musashi
BUILD   := $(ROOT)/build/oracle
GEN     := $(BUILD)/gen

HOOK := -DM68K_INSTRUCTION_HOOK=M68K_OPT_SPECIFY_HANDLER \
        -DM68K_INSTRUCTION_CALLBACK\(pc\)=oracle_instr_hook\(pc\)

CFLAGS := -O2 -fPIC -w -I$(MUSASHI) -I$(GEN) $(HOOK) \
          -include $(ROOT)/tools/oracle/oracle_hook.h

GENSRC := $(GEN)/m68kops.c
CORE   := $(MUSASHI)/m68kcpu.c $(MUSASHI)/m68kdasm.c $(MUSASHI)/softfloat/softfloat.c
SHIM   := $(ROOT)/tools/oracle/shim.c

all: $(BUILD)/liboracle.so

# m68kmake expands m68k_in.c into the opcode jump tables.
$(BUILD)/m68kmake: $(MUSASHI)/m68kmake.c
	@mkdir -p $(BUILD)
	$(CC) -O2 -w -o $@ $<

$(GENSRC): $(BUILD)/m68kmake $(MUSASHI)/m68k_in.c
	@mkdir -p $(GEN)
	cd $(GEN) && $(BUILD)/m68kmake $(GEN) $(MUSASHI)/m68k_in.c

$(BUILD)/liboracle.so: $(GENSRC) $(CORE) $(SHIM) $(ROOT)/tools/oracle/shim.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -shared -o $@ $(GENSRC) $(CORE) $(SHIM)

clean:
	rm -rf $(BUILD)

.PHONY: all clean
