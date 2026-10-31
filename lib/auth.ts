import { supabase } from "@/lib/supabase";

export const loginWithGoogle = async () => {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/`,
    },
  });

  if (error) {
    console.error("Google Login Error:", error);
  }
};
