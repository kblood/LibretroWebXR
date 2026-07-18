/* Makefile.iopglobal's imports.lst rule unconditionally prepends
 * #include "irx_imports.h" before the project's imports.lst content. This
 * ps2sdk build only defines DECLARE_IMPORT_TABLE/DECLARE_IMPORT/END_IMPORT_TABLE
 * in <irx.h> itself (no separate irx_imports.h ships in the SDK), so this
 * local shim just forwards to it. */
#include <irx.h>
