local context = Context.new()
context:merge(catalog.render("agent-files/agent-sync", context))
context:merge(catalog.render("agent-files/pre-push", context))
context:merge(catalog.render("agent-files/pr-workflow", context))
return context
