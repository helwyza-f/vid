"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useLocale } from "next-intl";
import { useRouter } from "@/navigation";
import Image from "next/image";
import { createClient } from "@/utils/supabase/client";
import {
  createProject,
  deleteProject,
  listProjects,
  updateProject,
} from "@/lib/cloud-projects";
import type { CloudProject } from "@/types/cloud-project.types";

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function ProjectsClient() {
  const router = useRouter();
  const locale = useLocale();
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.replace("/login");
        return;
      }

      setProjects(await listProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load projects");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const project = await createProject("Untitled project");
      router.push(`/editor?projectId=${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (projectId: string) => {
    setError(null);
    try {
      await deleteProject(projectId);
      setProjects((prev) => prev.filter((project) => project.id !== projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete project");
    }
  };

  const handleRename = async (project: CloudProject, title: string) => {
    const nextTitle = title.trim() || "Untitled project";

    setRenamingProjectId(project.id);
    setError(null);
    setProjects((prev) => prev.map((item) => (
      item.id === project.id ? { ...item, title: nextTitle } : item
    )));

    try {
      const updatedProject = await updateProject(project.id, { title: nextTitle });
      setProjects((prev) => prev.map((item) => (
        item.id === project.id ? updatedProject : item
      )));
    } catch (err) {
      setProjects((prev) => prev.map((item) => (
        item.id === project.id ? project : item
      )));
      setError(err instanceof Error ? err.message : "Could not rename project");
    } finally {
      setRenamingProjectId(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#09090B] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-8">
        <header className="flex items-center justify-between gap-4 border-b border-white/10 pb-6">
          <div className="flex items-center gap-3">
            <Image src="/svg/logo-openvid.svg" alt="" width={40} height={40} className="size-10" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
              <p className="text-sm text-white/45">Cloud synced editing spaces for your videos.</p>
            </div>
          </div>

          <button
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Icon icon={creating ? "svg-spinners:ring-resize" : "solar:add-circle-bold"} className="size-4" />
            New project
          </button>
        </header>

        {error && (
          <div className="mt-6 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <section className="grid flex-1 content-start gap-4 py-8 sm:grid-cols-2 lg:grid-cols-3">
          {loading ? (
            Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-52 animate-pulse rounded-lg border border-white/10 bg-white/[0.03]" />
            ))
          ) : projects.length === 0 ? (
            <button
              onClick={handleCreate}
              className="col-span-full flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] text-center transition hover:border-white/30 hover:bg-white/[0.04]"
            >
              <Icon icon="solar:folder-with-files-outline" className="mb-4 size-10 text-white/50" />
              <span className="text-base font-medium">No projects yet</span>
              <span className="mt-1 text-sm text-white/45">Create your first cloud project.</span>
            </button>
          ) : (
            projects.map((project) => (
              <article
                key={project.id}
                className="group overflow-hidden rounded-lg border border-white/10 bg-[#111114] transition hover:border-white/20"
              >
                <button
                  onClick={() => router.push(`/editor?projectId=${project.id}`)}
                  className="block w-full text-left"
                >
                  <div className="flex aspect-video items-center justify-center bg-black/50">
                    {project.thumbnailPath ? (
                      <div className="text-xs text-white/40">Thumbnail</div>
                    ) : (
                      <Icon icon="solar:video-frame-play-horizontal-outline" className="size-10 text-white/30" />
                    )}
                  </div>
                </button>
                <div className="p-4">
                  <div className="flex items-center gap-2">
                    <input
                      value={project.title}
                      disabled={renamingProjectId === project.id}
                      onChange={(event) => {
                        const title = event.target.value;
                        setProjects((prev) => prev.map((item) => (
                          item.id === project.id ? { ...item, title } : item
                        )));
                      }}
                      onBlur={(event) => handleRename(project, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-0 py-1 text-sm font-medium text-white outline-none transition hover:border-white/10 hover:bg-white/[0.03] focus:border-sky-400/60 focus:bg-white/[0.04] focus:px-2 disabled:opacity-60"
                      aria-label={`Rename ${project.title}`}
                    />
                    {renamingProjectId === project.id && (
                      <Icon icon="svg-spinners:ring-resize" className="size-4 shrink-0 text-white/45" />
                    )}
                  </div>
                  <p className="mt-1 text-xs text-white/40">
                    Updated {formatDate(project.updatedAt)} - {project.duration.toFixed(0)}s
                  </p>
                </div>
                <div className="flex items-center justify-between border-t border-white/5 px-4 py-2">
                  <span className="text-[11px] uppercase tracking-wide text-white/30">{locale}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => router.push(`/editor?projectId=${project.id}`)}
                      className="rounded-md p-1.5 text-white/35 transition hover:bg-white/5 hover:text-white"
                      aria-label={`Open ${project.title}`}
                    >
                      <Icon icon="solar:pen-new-square-linear" className="size-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(project.id)}
                      className="rounded-md p-1.5 text-white/35 transition hover:bg-red-500/10 hover:text-red-300"
                      aria-label={`Delete ${project.title}`}
                    >
                      <Icon icon="solar:trash-bin-trash-outline" className="size-4" />
                    </button>
                  </div>
                </div>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
